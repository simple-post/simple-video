# Changelog

## 1.0.0 — 2026-11-22

- The README, examples and agent skill use `@simple-post/video@latest` to select the current stable CLI. The skill asks agents to check the version when using an installed copy.
- `next` and `hint` commands repeat the npx invocation when the CLI runs through npx. Unknown flag or command errors name the running version.
- `plan` reports `imageSource`. Local recipes list the `localFiles` that will render instead of an image model. `init --local` recipes describe the demo artwork, and `init --photo` slideshows no longer set the generation-only `referencePrevious` flag.
- Export results no longer point at a separate publishing CLI. The skill states when paid generation is authorized, and the README covers Claude Code and platform support.

## 0.4.0 — 2026-11-21

- Read the bundled agent instructions from any npm install with `skill --print`. The README starts with natural-language requests an agent can carry through to a local MP4.
- Use `init --photo` for supplied photos. Repeat it in playback order to create a slideshow with no image API requests.
- Use `create --output` to render and export in the same call. Results include a contact sheet and the finished file path. Repeating the command can reuse an identical export.
- Use `setup --runtime-only` to install the renderer after approval without choosing or changing credential storage.

## 0.3.0 — 2026-10-29

- Setup and authentication offer native OS storage (macOS Keychain, Linux Secret Service, Windows Credential Manager), explicit file storage or environment-only access. `--storage` provides the choice for automation, and `setup --auth-only` changes it without runtime downloads.
- Native secrets use a pinned optional binding in an isolated helper with IPC-only transport and a bounded timeout. Missing/locked stores fail without falling back; Linux explicitly requires persistent Secret Service.
- Explicit file-to-native migration verifies read-back before removing the original. Writer locks protect login/logout/migration, and status reports backend identity without exposing key values.
- Releases now require real native-store create/read/update/delete and migration checks on all three operating systems.

## 0.2.0 — 2026-10-28

- Describe images directly with `init --prompt`, repeated prompts/captions for slideshows, and hero/opponent/setting flags for comparisons. Terminal initialization asks for missing descriptions, and init/plan show what will be generated. Custom photos have no on-screen caption unless one is supplied.
- `auth login` saves an OpenAI key once per computer with hidden entry; `auth status` reports only source/location and `auth logout` removes it. Private, unencrypted config files stay outside projects. Explicit environment/env-file keys take precedence, and agents can import from stdin/environment without key-value command arguments.
- Initialization now defaults to a single photo and requires content in automation. Use `--example` for preset editable recipes or `--local` for original geometric demo artwork. Existing saved recipes and generation authorization remain unchanged.

## 0.1.1 — 2026-10-28

- Setup explains downloads, installation locations and potential disk use, then asks for confirmation with a default of No. Unattended installs require explicit `--yes`; `--dry-run` always makes no changes.
- Readable terminal progress, elapsed-time updates, actionable errors and result summaries. `--json --no-input` preserves machine-readable automation; piped stdout defaults to JSON and `--human` forces text.

## 0.1.0

- Non-interactive `simple-video` CLI with JSON results, planning, resumable image generation, local-photo import and export.
- Managed Python/DepthFlow setup, subtle parallax presets, captions and local audio mixing.
- Re-rendering from verified cached images without additional image-generation requests.
- Portable AI-agent skill, examples and setup/reference documentation.
- Public package `@simple-post/video`; tag-driven GitHub Actions releases through npm trusted publishing, matching SimplePost core's release conventions.
