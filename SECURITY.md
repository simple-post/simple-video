# Security and privacy

Report vulnerabilities privately to the repository maintainers using GitHub's private reporting when available, or a private maintainer channel. Do not include secrets in public issues.

The CLI runs trusted local recipes and can read the images/audio explicitly named by them. It is not a sandbox for untrusted multi-tenant input. Keep your API keys in environment variables or an ignored env file selected with `--env-file`; there are no API-key command-line flags. Never commit keys, raw responses, runtime files or private media.

Paid image generation requires `--execute`. Request caps and estimate reservations are enforced, but the provider controls actual billing. Uncertain requests stop for inspection. Do not automatically retry them with the override flag.

Setup shows its plan and requires interactive confirmation or explicit `--yes` before downloads or installation. JSON/non-interactive setup without approval fails before creating runtime files or contacting download services. Setup downloads pinned uv release artifacts and verifies their SHA-256 before execution. Python packages are installed in an isolated environment; transitive packages are resolved by uv. Follow dependency updates and platform advisories. System GPU drivers and FFmpeg are managed by the user.

The CLI never uploads exports or posts to social accounts. Its stdout/stderr errors redact common provider key patterns; do not treat that as a substitute for keeping raw cache/receipt files private.
