# Changelog

## 0.1.1 — 2026-10-28

- Setup explains downloads, installation locations and potential disk use, then asks for confirmation with a default of No. Unattended installs require explicit `--yes`; `--dry-run` always makes no changes.
- Readable terminal progress, elapsed-time updates, actionable errors and result summaries. `--json --no-input` preserves machine-readable automation; piped stdout defaults to JSON and `--human` forces text.

## 0.1.0

- Non-interactive `simple-video` CLI with JSON results, planning, resumable image generation, local-photo import and export.
- Managed Python/DepthFlow setup, subtle parallax presets, captions and local audio mixing.
- Re-rendering from verified cached images without additional image-generation requests.
- Portable AI-agent skill, examples and setup/reference documentation.
- Public package `@simple-post/video`; tag-driven GitHub Actions releases through npm trusted publishing, matching SimplePost core's release conventions.
