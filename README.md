# Angles Release Video

Create an Angles product video from your repository homepage whenever you publish a GitHub Release.

The Action sends only the homepage URL to Angles. It does not read your repository files or Release Notes. It uses the existing Angles URL-to-video flow and an existing recommended template.

## Setup

Create an Angles API key with `concepts:write`, `videos:read`, and `videos:render`, then add it to your repository as the `ANGLES_API_KEY` Actions secret.

Add this workflow to `.github/workflows/angles-repo-video.yml`:

```yaml
name: Create release video

on:
  release:
    types: [published]

permissions:
  contents: read

jobs:
  video:
    runs-on: ubuntu-latest
    steps:
      - uses: anglesvideo/anglesvideo-release-video-action@v1
        with:
          api-key: ${{ secrets.ANGLES_API_KEY }}
```

Set the repository's **Website** field to your product homepage. Or provide a URL explicitly:

```yaml
      - uses: anglesvideo/anglesvideo-release-video-action@v1
        with:
          api-key: ${{ secrets.ANGLES_API_KEY }}
          product-url: https://example.com
```

The rendered video URL is available as the `video-url` output and in the workflow run summary. GitHub Releases do not have a comment thread, so this Action intentionally does not modify a Release.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | Yes | — | Angles API key. Pass it from an Actions secret. |
| `product-url` | No | Repository homepage | Homepage to use as the video source. |
| `api-base-url` | No | `https://api.angles.video/api/developer/v1` | Angles Developer API base URL. |
| `template-id` | No | First Angles recommendation | Existing template to use. |
| `aspect-ratio` | No | `landscape` | `landscape` or `portrait`. |
| `timeout-seconds` | No | `900` | Maximum render wait, between 60 and 3600 seconds. |
| `poll-interval-seconds` | No | `10` | Status check interval, between 3 and 60 seconds. |

## Outputs

| Output | Description |
| --- | --- |
| `video-url` | Final hosted video URL. |
| `edit-url` | Angles editor link. |
| `video-id` | Angles video ID. |

## Release

This repository is ready for GitHub Marketplace: keep `action.yml` at the repository root, publish it as a public repository, then create a tagged release such as `v1.0.0` and choose **Publish this Action to the GitHub Marketplace**.

The committed `dist/index.js` is the runtime GitHub executes. After modifying `src/index.js`, run `npm run build` and commit both files.
