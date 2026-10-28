# Working on Simple Video

This is the standalone `simple-post/simple-video` repository for the public `@simple-post/video` npm package. The GitHub repository remains private unless the user requests a visibility change. Releases use `video-v*` tags and `.github/workflows/release.yml`, mirroring core. Publishing or creating release tags requires a user request; preparing a package or merging code alone does not authorize a release.

Use Node.js 24+. Run `npm test`, `npm run check`, `npm run format:check`, and `npm run check:package` for changes to the CLI/engine. Tests use fixtures and mocked APIs; do not make paid image requests unless the user authorizes them. Runtime setup downloads are separate from generation. Setup must show its plan and ask before installing in a terminal; automation requires explicit `setup --yes`. Preserve non-interactive `--json --no-input` operation, the stdout JSON / stderr progress contract in JSON mode, and readable terminal output by default. Declining setup or omitting unattended approval must have no filesystem/network side effects.

Keep code, docs, examples and the bundled skill synchronized. Paths must work outside this checkout. Do not reference the maintainer's machine, production accounts, VPS, n8n, personal media or another project's credentials. No credentials or runtime assets belong in Git or npm artifacts. DepthFlow remains a separately installed dependency with its own AGPL license; preserve notices and the explicit renderer boundary.

Do not change the original Paleoflux project while working here. Never silently replace DepthFlow with the CPU renderer. No generation command should upload or publish media.
