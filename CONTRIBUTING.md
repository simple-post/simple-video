# Contributing

Simple Video is an early-stage CLI published as `@simple-post/video`. Use Node.js 24+, FFmpeg and ffprobe. Install with `npm ci`, build with `npm run build`, and run `npm test`, `npm run check` and `npm run format:check` before a pull request.

Tests use mocks and original fixtures. No real image API key is needed. To verify the native renderer, use a separate `--home` directory, run `setup`, then `doctor --check-render`. Report operating system, CPU/GPU, Node version and the redacted doctor result. Never attach credentials, private photos or raw provider responses to issues.

Prefer small reproducible recipe examples. Add meaningful tests for request retries, costs, path handling and media output when those behaviors change. Update docs and the agent skill for public command changes. Keep scope focused on photo-parallax production; publishing belongs to SimplePost.

`skills/simple-video` is the source for both the skills.sh install and the skill bundled on npm. Keep those instructions compatible with the current public npm release. If a new instruction requires a feature that has yet to ship, document the minimum CLI version when that feature is released.

`npm run check:package` validates the built artifact. Maintainers publish npm packages from matching release tags using [trusted publishing](docs/releases.md).
