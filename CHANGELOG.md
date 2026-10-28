# Changelog

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
