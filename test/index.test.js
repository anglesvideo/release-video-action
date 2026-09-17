const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { booleanInput, errorMessage, input, numberInput, releaseBodyWithVideo, renderSettings, run, selectConcept } = require('../src/index.js');

test('reads GitHub Action inputs and validates numeric inputs', () => {
  assert.equal(input('api-key', { 'INPUT_API-KEY': ' key ' }), 'key');
  assert.equal(input('api-key', { INPUT_API_KEY: ' key ' }), 'key');
  assert.equal(numberInput('timeout-seconds', { minimum: 1, maximum: 10, fallback: 5 }, {}), 5);
  assert.throws(
    () => numberInput('timeout-seconds', { minimum: 1, maximum: 10, fallback: 5 }, { INPUT_TIMEOUT_SECONDS: '0' }),
    /between 1 and 10/
  );
  assert.equal(booleanInput('publish-to-release', true, { INPUT_PUBLISH_TO_RELEASE: 'false' }), false);
});

test('prefers the specific API error reason over the generic message', () => {
  assert.equal(
    errorMessage({ message: 'Bad Request Exception', details: { message: ['url must be a URL'] } }, 400),
    'url must be a URL'
  );
  assert.equal(errorMessage({ message: 'Insufficient credits', details: 'Insufficient credits' }, 402), 'Insufficient credits');
  assert.equal(errorMessage('<html>', 502), 'Angles API request failed with HTTP 502');
});

test('adds one replaceable video block to a Release body', () => {
  const once = releaseBodyWithVideo('## Changes\n\n- Fix login', 'https://cdn.example.com/one.mp4');
  const twice = releaseBodyWithVideo(once, 'https://cdn.example.com/two.mp4');
  assert.match(twice, /two\.mp4/);
  assert.doesNotMatch(twice, /one\.mp4/);
  assert.equal((twice.match(/angles-release-video:start/g) || []).length, 1);
});

test('uses the first recommended existing template and supported scraped screenshots', () => {
  const response = {
    source: { productImages: ['https://cdn.example.com/one.png', 'https://cdn.example.com/two.png'] },
    concepts: [{
      videoId: 'video-1',
      recommendedTemplates: [{ id: 'screen_demo', media: { acceptsImages: true, minimumImages: 2 } }],
    }],
  };
  const { selectedConcept, templateId } = selectConcept(response);
  assert.equal(templateId, 'screen_demo');
  assert.deepEqual(renderSettings(response, selectedConcept, templateId), {
    templateId: 'screen_demo',
    productImages: response.source.productImages,
  });
});

test('runs the URL-to-video flow and writes outputs and a summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'angles-action-'));
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'output.txt');
  const summaryPath = join(directory, 'summary.md');
  await writeFile(eventPath, JSON.stringify({
    repository: { homepage: 'https://example.com' },
    release: {
      url: 'https://api.github.test/repos/angles/repo/releases/1',
      html_url: 'https://github.test/angles/repo/releases/tag/v1.0.0',
      body: '## Changes',
    },
  }));
  const requests = [];
  const responses = [
    { concepts: [{ videoId: 'video-1', recommendedTemplates: [{ id: 'screen_demo', media: { acceptsImages: false, minimumImages: 0 } }] }], source: { productImages: [] } },
    { canRender: true, blockers: [] },
    { status: 'rendering' },
    { status: 'rendered', videoUrl: 'https://cdn.angles.video/video.mp4', editUrl: 'https://angles.video/edit/video-1' },
    { html_url: 'https://github.test/angles/repo/releases/tag/v1.0.0' },
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = responses.shift();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  let ticks = 0;
  const result = await run({
    environment: {
      INPUT_API_KEY: 'secret',
      INPUT_GITHUB_TOKEN: 'github-secret',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_RUN_ID: '123',
      INPUT_POLL_INTERVAL_SECONDS: '3',
    },
    fetchImpl,
    sleep: async () => { ticks += 1; },
    now: () => ticks * 1000,
  });

  assert.equal(result.videoUrl, 'https://cdn.angles.video/video.mp4');
  assert.equal(requests.length, 5);
  assert.equal(requests.at(-1).options.method, 'PATCH');
  assert.match(requests.at(-1).options.body, /Product video/);
  assert.match(await readFile(outputPath, 'utf8'), /video-url=https:\/\/cdn\.angles\.video\/video\.mp4/);
  assert.match(await readFile(outputPath, 'utf8'), /release-url=https:\/\/github\.test/);
  assert.match(await readFile(summaryPath, 'utf8'), /Angles Release Video/);
});
