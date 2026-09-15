const { appendFile, readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const DEFAULT_API_BASE_URL = 'https://api.angles.video/api/developer/v1';

function input(name, environment = process.env) {
  const upperName = name.toUpperCase();
  return (
    environment[`INPUT_${upperName}`]
    || environment[`INPUT_${upperName.replace(/-/g, '_')}`]
    || ''
  ).trim();
}

function numberInput(name, { minimum, maximum, fallback }, environment = process.env) {
  const raw = input(name, environment);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function booleanInput(name, fallback, environment = process.env) {
  const raw = input(name, environment);
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

async function eventPayload(environment = process.env, files = { readFile }) {
  const path = environment.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(await files.readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the GitHub event payload: ${error.message}`);
  }
}

async function request(apiBaseUrl, apiKey, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && body.message
      ? Array.isArray(body.message) ? body.message.join('; ') : String(body.message)
      : `Angles API request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function renderSettings(conceptResponse, selectedConcept, templateId) {
  const selectedTemplate = (selectedConcept.recommendedTemplates || []).find(
    template => template.id === templateId || template.id.split(':')[0] === templateId.split(':')[0]
  );
  const images = conceptResponse.source?.productImages || [];
  const media = selectedTemplate?.media;
  const canUseImages = media?.acceptsImages && images.length >= (media.minimumImages || 0);
  return {
    templateId,
    ...(canUseImages ? { productImages: images } : {}),
  };
}

function selectConcept(conceptResponse, requestedTemplateId) {
  const concepts = conceptResponse?.concepts;
  if (!Array.isArray(concepts) || concepts.length === 0) {
    throw new Error('Angles did not return a video concept for this homepage.');
  }
  const selectedConcept = requestedTemplateId
    ? concepts.find(concept =>
        (concept.recommendedTemplates || []).some(
          template => template.id === requestedTemplateId || template.id.split(':')[0] === requestedTemplateId.split(':')[0]
        )
      ) || concepts[0]
    : concepts[0];
  const templateId = requestedTemplateId || selectedConcept.recommendedTemplates?.[0]?.id;
  if (!selectedConcept.videoId || !templateId) {
    throw new Error('Angles returned a concept without a renderable video or template.');
  }
  return { selectedConcept, templateId };
}

async function writeOutput(name, value, environment = process.env, files = { appendFile }) {
  if (!value || !environment.GITHUB_OUTPUT) return;
  await files.appendFile(environment.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function writeSummary(lines, environment = process.env, files = { appendFile }) {
  if (!environment.GITHUB_STEP_SUMMARY) return;
  await files.appendFile(environment.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function releaseBodyWithVideo(releaseBody, videoUrl) {
  const block = [
    '<!-- angles-release-video:start -->',
    '## 🎬 Product video',
    '',
    `[Watch the release video](${videoUrl})`,
    '<!-- angles-release-video:end -->',
  ].join('\n');
  const pattern = /<!-- angles-release-video:start -->[\s\S]*?<!-- angles-release-video:end -->/;
  if (pattern.test(releaseBody || '')) return (releaseBody || '').replace(pattern, block);
  return [releaseBody || '', block].filter(Boolean).join('\n\n');
}

async function publishVideoToRelease({ event, token, videoUrl, environment, fetchImpl }) {
  if (!event.release?.url || !event.release?.html_url) {
    throw new Error('publish-to-release requires this Action to run from a GitHub Release event.');
  }
  if (!token) {
    throw new Error('Missing github-token. Pass github-token: ${{ github.token }} and grant contents: write.');
  }
  const releaseBody = releaseBodyWithVideo(event.release.body, videoUrl);
  const response = await fetchImpl(event.release.url, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body: releaseBody }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not add the video to the GitHub Release (HTTP ${response.status}): ${details}`);
  }
  const release = await response.json();
  return release.html_url || event.release.html_url;
}

async function run({ environment = process.env, fetchImpl = fetch, files = { readFile, appendFile }, sleep = pause, now = Date.now } = {}) {
  const apiKey = input('api-key', environment);
  if (!apiKey) throw new Error('Missing api-key. Store it as an Actions secret and pass it to this Action.');

  const event = await eventPayload(environment, files);
  const productUrl = input('product-url', environment) || event.repository?.homepage || '';
  if (!productUrl) {
    throw new Error('Missing product-url. Set the repository homepage or pass product-url explicitly.');
  }
  let url;
  try {
    url = new URL(productUrl);
  } catch {
    throw new Error('product-url must be a complete http(s) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('product-url must use http or https.');
  }

  const aspectRatio = input('aspect-ratio', environment) || 'landscape';
  if (!['landscape', 'portrait'].includes(aspectRatio)) {
    throw new Error('aspect-ratio must be landscape or portrait.');
  }
  const timeoutSeconds = numberInput('timeout-seconds', { minimum: 60, maximum: 3600, fallback: 900 }, environment);
  const pollIntervalSeconds = numberInput('poll-interval-seconds', { minimum: 3, maximum: 60, fallback: 10 }, environment);
  const requestedTemplateId = input('template-id', environment);
  const publishToRelease = booleanInput('publish-to-release', true, environment);
  const apiBaseUrl = (input('api-base-url', environment) || DEFAULT_API_BASE_URL).replace(/\/$/, '');

  console.log(`Creating an Angles video from ${url.toString()}`);
  const conceptResponse = await request(
    apiBaseUrl,
    apiKey,
    '/concepts/from-url',
    {
      method: 'POST',
      body: JSON.stringify({
        url: url.toString(),
        aspectRatio,
        ...(requestedTemplateId ? { preferredTemplateId: requestedTemplateId } : {}),
      }),
    },
    fetchImpl
  );
  const { selectedConcept, templateId } = selectConcept(conceptResponse, requestedTemplateId);
  const settings = renderSettings(conceptResponse, selectedConcept, templateId);

  const preview = await request(
    apiBaseUrl,
    apiKey,
    `/videos/${encodeURIComponent(selectedConcept.videoId)}/render/preview`,
    { method: 'POST', body: JSON.stringify(settings) },
    fetchImpl
  );
  if (!preview?.canRender) {
    const reasons = Array.isArray(preview?.blockers) ? preview.blockers.join('; ') : 'Unknown render blocker.';
    throw new Error(`Angles cannot render this video: ${reasons}`);
  }

  const runId = environment.GITHUB_RUN_ID || randomUUID();
  await request(
    apiBaseUrl,
    apiKey,
    `/videos/${encodeURIComponent(selectedConcept.videoId)}/render`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': `github-${runId}-${selectedConcept.videoId}` },
      body: JSON.stringify({ ...settings, confirmed: true }),
    },
    fetchImpl
  );

  const deadline = now() + timeoutSeconds * 1000;
  let video;
  do {
    video = await request(
      apiBaseUrl,
      apiKey,
      `/videos/${encodeURIComponent(selectedConcept.videoId)}`,
      {},
      fetchImpl
    );
    if (video.videoUrl) break;
    if (video.status === 'failed') {
      throw new Error(`Angles could not render the video. ${video.editUrl ? `Open ${video.editUrl} for details.` : ''}`);
    }
    if (now() >= deadline) break;
    await sleep(pollIntervalSeconds * 1000);
  } while (now() < deadline);

  await writeOutput('video-id', selectedConcept.videoId, environment, files);
  await writeOutput('edit-url', video?.editUrl, environment, files);
  if (!video?.videoUrl) {
    await writeSummary([
      '## Angles Release Video',
      'The render is still running.',
      video?.editUrl ? `Continue in Angles: ${video.editUrl}` : `Video ID: \`${selectedConcept.videoId}\``,
    ], environment, files);
    throw new Error(`Timed out after ${timeoutSeconds}s waiting for the video. The render may still finish in Angles.`);
  }

  await writeOutput('video-url', video.videoUrl, environment, files);
  let releaseUrl;
  if (publishToRelease) {
    releaseUrl = await publishVideoToRelease({
      event,
      token: input('github-token', environment),
      videoUrl: video.videoUrl,
      environment,
      fetchImpl,
    });
    await writeOutput('release-url', releaseUrl, environment, files);
  }
  await writeSummary([
    '## Angles Release Video',
    `Video: ${video.videoUrl}`,
    ...(releaseUrl ? [`Added to Release: ${releaseUrl}`] : []),
    ...(video.editUrl ? [`Edit: ${video.editUrl}`] : []),
  ], environment, files);
  console.log(`Angles video ready: ${video.videoUrl}`);
  return { videoId: selectedConcept.videoId, videoUrl: video.videoUrl, editUrl: video.editUrl, releaseUrl };
}

if (require.main === module) {
  run().catch(error => {
    console.error(`Angles repo video failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { booleanInput, input, numberInput, releaseBodyWithVideo, renderSettings, run, selectConcept };
