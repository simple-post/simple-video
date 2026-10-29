# Security and privacy

Report vulnerabilities privately to the repository maintainers using GitHub's private reporting when available, or a private maintainer channel. Do not include secrets in public issues.

The CLI runs trusted local recipes and can read the images/audio explicitly named by them. It is not a sandbox for untrusted multi-tenant input. Setup/authentication require a storage choice. Native storage uses macOS Keychain, Linux Secret Service (explicitly pinned; no kernel-keyring fallback), or Windows Credential Manager through a native binding. Keys travel over private helper IPC, not command arguments or helper environment variables; native stdout/stderr is suppressed and operations time out. Store failures never silently downgrade protection.

File storage is explicit and unencrypted. Unix directories/files must be owned by the current user with `0700`/`0600` permissions; symlinks are rejected. Windows relies on the user directory's ACLs. Environment-only mode persists no key. Environment variables and explicit `--env-file` override the selected store. Authentication does not contact the provider. File-to-native migration verifies read-back before removing the original, under a writer lock; failed migration preserves the source and failed cleanup is reported. Backups may retain old copies. Never commit keys, raw responses, runtime files or private media. See [credential storage](docs/authentication.md).

Paid image generation requires `--execute`. Request caps and estimate reservations are enforced, but the provider controls actual billing. Uncertain requests stop for inspection. Do not automatically retry them with the override flag.

Setup shows its plan and requires interactive confirmation or explicit `--yes` before downloads or installation. JSON/non-interactive setup without approval fails before creating runtime files or contacting download services. Setup downloads pinned uv release artifacts and verifies their SHA-256 before execution. Python packages are installed in an isolated environment; transitive packages are resolved by uv. Follow dependency updates and platform advisories. System GPU drivers and FFmpeg are managed by the user.

The CLI never uploads exports or posts to social accounts. Its stdout/stderr errors redact common provider key patterns; do not treat that as a substitute for keeping raw cache/receipt files private.
