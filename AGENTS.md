# Working on Simple Video

This is the standalone `simple-post/simple-video` CLI. The repository is private during development; do not make it public or publish npm packages without a new explicit request. Keep `private: true` and the npm publication guard in place.

Use Node.js 24+. Run `npm test`, `npm run check`, `npm run format:check`, and `npm pack --dry-run` for changes to the CLI/engine. Tests use fixtures and mocked APIs; do not make paid image requests unless the user authorizes them. Runtime setup downloads are separate from generation. Keep terminal commands non-interactive and preserve the stdout JSON / stderr progress contract.

Keep code, docs, examples and the bundled skill synchronized. Paths must work outside this checkout. Do not reference the maintainer's machine, production accounts, VPS, n8n, personal media or another project's credentials. No credentials or runtime assets belong in Git or npm artifacts. DepthFlow remains a separately installed dependency with its own AGPL license; preserve notices and the explicit renderer boundary.

Do not change the original Paleoflux project while working here. Never silently replace DepthFlow with the CPU renderer. No generation command should upload or publish media.
