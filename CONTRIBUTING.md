# Contributing

Simple Video is a private preview being prepared for open source. Use Node.js 24+, FFmpeg and ffprobe. Install with `npm ci`, build with `npm run build`, and run `npm test`, `npm run check` and `npm run format:check` before a pull request.

Tests use mocks and original fixtures. No real image API key is needed. To verify the native renderer, use a separate `--home` directory, run `setup`, then `doctor --check-render`. Report operating system, CPU/GPU, Node version and the redacted doctor result. Never attach credentials, private photos or raw provider responses to issues.

Prefer small reproducible recipe examples. Add meaningful tests for request retries, costs, path handling and media output when those behaviors change. Update docs and the agent skill for public command changes. Keep scope focused on photo-parallax production; publishing belongs to SimplePost.

`npm pack --dry-run` checks package contents without publishing. `private: true` and `scripts/no-publish.mjs` intentionally block publication. There is no npm release workflow. Public release, license review of bundled dependencies and npm naming are separate maintainer decisions.
