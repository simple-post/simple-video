# Credential storage

Both `simple-video setup` and `simple-video auth login` ask how credentials should be handled. The native OS store is the recommended menu choice. Nothing silently falls back to a file or Linux's memory-only kernel keyring.

| Choice     | macOS                                                                     | Linux                                                                                       | Windows                                                |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `keychain` | macOS Keychain                                                            | Secret Service over the user's D-Bus session (GNOME Keyring, KWallet or compatible service) | Windows Credential Manager                             |
| `file`     | Private, unencrypted local JSON file                                      | Private, unencrypted local JSON file                                                        | Local JSON file protected by the user directory's ACLs |
| `env`      | Read `OPENAI_API_KEY` or an explicit `--env-file`; do not persist the key | Same                                                                                        | Same                                                   |

## Choose and authenticate

```sh
simple-video setup --auth-only       # choose storage without renderer downloads
simple-video auth login              # choose storage, then enter a hidden key
simple-video auth status              # source, store and location; never key values
simple-video auth logout              # remove the key in the selected store
```

Full `setup` asks for installation approval first, then the storage choice, and saves the preference only after installation succeeds. `--auth-only` changes only the storage preference; it does not ask for a key. Authentication shows the selected store before hidden entry. Environment mode asks for no key and saves only the preference. Choosing another backend leaves existing keys in other backends untouched.

For agents or scripts, select the backend explicitly on first use:

```sh
simple-video setup --yes --storage env --json --no-input
simple-video setup --auth-only --storage keychain --json --no-input
simple-video auth login --storage keychain --from-env --json --no-input
simple-video auth login --storage file --from-env --json --no-input
simple-video auth login --storage env --json --no-input
```

`--from-env` imports an already-supplied `OPENAI_API_KEY`; an explicit global `--env-file FILE` can supply it. `--stdin` imports from a secure pipe instead. Never put a secret literal in a shell command. Environment-only mode rejects input-source/import flags because it never saves a key. A saved backend choice can be reused in non-interactive commands; a fresh config without `--storage` fails with `STORAGE_SELECTION_REQUIRED`, before reading key input or changing files. `--dry-run` always prevents preference writes and installation.

Runtime credential precedence is: current environment, explicit env file filling missing variables, then the selected saved store. Environment-only mode ignores saved keys. No key is read from an unrelated project or scanned from the user's keychain. Login/status do not call OpenAI and cannot verify credit or model access.

## Native stores and failures

Native integration uses the optional, pinned `@napi-rs/keyring` binding with platform-specific prebuilt binaries. No compiler or shell helper is used to transport keys. The native helper receives secret values only over process IPC, with stdout/stderr suppressed; key values are never command arguments or helper environment variables. Blocking calls and OS unlock dialogs are bounded by a 30-second timeout.

Linux explicitly requires Secret Service. Its daemon and an unlocked user session must already exist; the CLI does not install or unlock a system keyring. On a headless machine, choose environment mode or explicitly choose file storage. macOS may request access to the login keychain, and Windows needs an accessible user credential store. OS-managed protection depends on the user's store configuration; it does not protect against every program running as that user.

Locked, unavailable, ambiguous, failed and timed-out operations return `AUTH_STORE_UNAVAILABLE`; absence alone returns an empty status or `removed: false`. Failed deletion is never reported as success. Install the native optional dependency when using an OS store. It loads lazily; file/environment authentication does not use it. No fallback occurs when a chosen native store is unavailable.

Release CI tests native create/read/update/delete and file-to-native migration on macOS, Linux and Windows before npm publication. `npm run test:native-auth` runs the same opt-in test locally using a unique dummy credential, deleting it in `finally`. Regular unit tests use isolated files and mock native stores, never real API keys.

## Files, namespace and migration

`authentication.json` contains only the selected backend. File mode stores the key in `credentials.json` in the same directory:

| Platform | Default directory                            |
| -------- | -------------------------------------------- |
| macOS    | `~/Library/Application Support/simple-video` |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/simple-video` |
| Windows  | `%LOCALAPPDATA%/simple-video`                |

Use `--config-dir DIR` or `SIMPLE_VIDEO_CONFIG_DIR` to override the directory. Unix files/directories must belong to the current user with `0600`/`0700` permissions; symlinks are rejected. Native entries use service `com.simple-post.video` and a config-directory-derived account, so separate configurations address separate credentials. Status/login show this non-secret identity. Keep the config directory stable when reusing native entries; moving it changes the account namespace.

Version 0.2.0's file key is not silently selected or moved. After choosing the OS store, interactive login offers migration, or request it explicitly:

```sh
simple-video auth login --storage keychain --migrate-file
```

Migration reads the original private file, writes the OS store, verifies exact read-back, saves the selection, then removes the original file. If writing or verification fails, the original remains. If removing the original fails, the CLI reports `AUTH_MIGRATION_INCOMPLETE` and warns that the plaintext copy still exists. A local writer lock prevents concurrent login/logout/migration from deleting a newly replaced key. Removing a file does not erase previous backups or filesystem snapshots.

To deliberately remove an old copy in a different backend:

```sh
simple-video auth logout --storage file
simple-video auth logout --storage keychain
```

Logout never edits environment variables, external env files or other stores. No real credential is migrated as part of an npm upgrade.
