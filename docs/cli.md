# CLI contract

In a terminal, commands print readable summaries and progress messages. Setup asks for approval with a default of **No**; `init` asks for missing image descriptions; `auth login` uses hidden key entry. All have non-interactive equivalents. No command needs a browser.

For agents and scripts, use `--json --no-input`. Piped stdout defaults to JSON; `--human` forces readable text when piping. `--human` and `--json` cannot be combined. `--json` never prompts, including when run in a terminal. `simple-video` and `simple-video --help` print help; `--version` prints the version. Other successful JSON-mode commands emit exactly one result on stdout:

```json
{
  "ok": true,
  "command": "create",
  "data": { "id": "first-video", "status": "ready" }
}
```

The actual `data` contains the command's complete result. `--no-input` prevents prompts; it never grants authorization or selects an output format. `--quiet` suppresses progress, not errors or approval. Progress uses stderr: readable step names and elapsed time in human mode, newline-delimited JSON in JSON mode:

```json
{ "event": "progress", "stage": "render", "scene": "shot-0" }
```

Errors also use stderr and a nonzero exit code:

```json
{
  "ok": false,
  "error": {
    "code": "SETUP_REQUIRED",
    "message": "OPENAI_API_KEY is missing..."
  }
}
```

Human-mode errors show a short `Error: ...` message instead of a JSON envelope. Use `--json` to inspect structured error codes, validation issues and details.

## Setup approval

```sh
simple-video setup                         # show plan, then ask [y/N]
simple-video setup --dry-run               # preview only; no downloads or prompt
simple-video setup --yes                   # explicit approval, readable terminal progress
simple-video setup --yes --json --no-input # unattended, machine-readable install
```

Without `--yes`, setup can ask only when stdin and stderr are terminals and neither `--json` nor `--no-input` is set. Otherwise it exits 2 with `CONFIRMATION_REQUIRED` before creating runtime files or making network requests; `error.details.plan` contains the proposed installation. A declined interactive prompt returns `executed: false` and `cancelled: true`, exiting 0. `--dry-run` always prevents installation, even with `--yes`. The flag belongs to setup and does not bypass `create --execute`.

Setup progress events contain `stage: "setup"`, a `step`, and `status: "started"` or `"complete"`. Completed steps include `elapsedMs`. Long human-mode steps print a periodic elapsed-time update rather than raw installer output.

| Exit | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Success; inspect `executed` for a plan-only create/setup |
| 1    | Operation, conflict, or filesystem failure               |
| 2    | Invalid input, or setup approval required                |
| 3    | Missing dependency/credential or graphics setup failure  |
| 4    | Provider HTTP failure                                    |
| 5    | Uncertain generation outcome; automatic retry blocked    |
| 6    | Request or estimated budget exhausted                    |

`doctor` can emit a successful diagnostic result with `ready: false` and exit 3. For scripts, check the exit code and JSON result. Error classification is deliberately coarse; the stable `code` and message explain the next action.

## Project and runtime selection

`--project DIR` defaults to the current directory. `--recipe FILE` defaults to `simple-video.json` inside it. Local image/music paths are relative to the recipe file, independent of the invocation directory. `--root DIR` selects the asset/run cache; otherwise it is `PROJECT/.simple-video`. Explicit `--root`, `--home` and `--env-file` paths are relative to the invocation directory.

`--home DIR` selects the managed runtime and wins over `SIMPLE_VIDEO_HOME`. `--config-dir DIR` selects saved-login storage and wins over `SIMPLE_VIDEO_CONFIG_DIR`; it is separate from runtime and project data. Environment variables supply keys; `--env-file FILE` fills missing supported values only. Generation/doctor then fall back to saved credentials. Only `auth login` writes credentials; `auth logout` removes the saved file.

## Authentication

`auth login` explains the destination, then reads your OpenAI key without echoing it. It stores `credentials.json` in a user-level config directory:

| Platform | Default directory                            |
| -------- | -------------------------------------------- |
| macOS    | `~/Library/Application Support/simple-video` |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/simple-video` |
| Windows  | `%LOCALAPPDATA%/simple-video`                |

The file is unencrypted. On Unix the directory must be owned by the user with `0700` permissions and the file with `0600` permissions. Symlinks and insecure stores are rejected. Windows file protection depends on the user directory's ACLs. Choose a private directory outside Git when overriding it. Credentials are not copied into recipes, run records or exports.

```sh
simple-video auth login
simple-video auth status --json
simple-video auth logout

# Persist a key already supplied by your environment:
simple-video auth login --from-env --json --no-input
# Import an existing env file once without copying its value manually:
simple-video --env-file ./my-private.env auth login --from-env --json --no-input
```

`--stdin` reads a key from piped standard input. Do not put secret literals in shell commands; pipe from a secret manager instead. `--stdin` and `--from-env` are mutually exclusive. JSON/non-interactive login without an explicit input source exits 2 with `INPUT_REQUIRED`. Login/status make no network request and report `validatedWithProvider: false`; presence does not guarantee model access or credit. `auth status` never reveals a key or key prefix. Logout leaves environment variables and external env files untouched.

## Image descriptions

`init` defaults to `single`: one `--prompt` describes the image and `--duration` defaults to six seconds. In a terminal it asks what image you want when no description is supplied. In automation missing descriptions return `INPUT_REQUIRED` without creating a project.

```sh
simple-video init ./photo --prompt "A T. rex at a coffee counter, realistic layered photograph" --duration 6
simple-video init ./story --template slideshow \
  --prompt "A triceratops entering a tiny gym, realistic layered photo" \
  --prompt "The same triceratops stuck in the gym doorway, realistic photo"
simple-video init ./fight --template comparison \
  --hero "A T. rex" --opponent "woolly mammoths" --setting "An open snowy valley"
```

Repeat `--prompt` 2–12 times for slideshow/challenge templates. Repeat `--caption` once per photo to add text, or omit it for no captions. `--duration` is per photo; it defaults to three seconds for those templates. Terminal initialization without prompts asks for three slideshow/challenge descriptions. Comparison initialization asks for missing hero, opponent and setting; edit round counts and timing in the recipe. `--name` sets the title.

`--local` explicitly creates geometric sample artwork and cannot be combined with image-description flags. `--example` explicitly writes preset descriptions for later editing. `init` makes no generation calls. The recipe stores single-image text in `prompt`, slideshow/challenge text in `shots[].prompt`, and comparison subjects/setting in `hero`, `opponent`, `environment` and `rounds`. Human `init` and `plan` output shows these descriptions. JSON plans retain the complete expanded prompts in `assets[].prompt` and add a short `descriptions` list for review.

## Planning and paid generation

```sh
simple-video --project ./story schema --json > schema-response.json
simple-video --project ./story plan
simple-video --project ./story create --id episode-01 --dry-run
simple-video --project ./story create --id episode-01 --execute
```

Use `.data` from `schema` as the JSON Schema. `plan` reports exact asset IDs, scenes, duration, estimate and `budgetFits`. A recipe containing `image.files` defaults to the local provider; otherwise the provider is OpenAI. Use `--provider fixture` for synthetic test images. The OpenAI provider rejects recipes containing `image.files` to avoid ambiguity. Local input requires a file for every planned asset. Mixing generated and local photos in one create command is not currently supported; generate images first, then use them in a local-photo recipe.

Without `--execute`, an OpenAI create returns a plan and sends no generation request. Local and fixture creates run without that flag. `--dry-run` prevents all generation and rendering regardless of provider. `--images-only` stops at `images-ready`; call create again without it to render the cached images, or use render to create a variant.

## Resuming and recovery

Reuse the same `--id` with identical settings to resume. A run ID cannot silently switch to different settings. Use a new ID after editing a recipe; identical asset requests can reuse shared cache entries.

Each image request records its state before sending. A saved complete response can be decoded after interruption without another request. An unknown outcome blocks that asset in other runs as well. After checking the provider, `--retry-uncertain` explicitly permits another potentially billable request. It still requires `--execute` and remains subject to the recipe's request cap. Never loop that flag automatically.

Local input content participates in the local provider identity. Modified source photos must use a new run ID; cached images and media are checked against hashes. One writer lock protects each asset root; run parallel jobs with separate roots. Stale locks owned by a dead process are recovered; ambiguous locks fail for inspection.

## Re-rendering and export

```sh
simple-video --project ./story render --run episode-01 --intensity 0.07
simple-video --project ./story render --run episode-01 --motion static
simple-video --project ./story status --run episode-01
simple-video --project ./story export --run episode-01 --output ./review
```

Rendering never calls an image provider and does not alter generation state. It may download missing local depth weights. Variants have their own video, contact sheet, validation report and `render.json`; the JSON result gives their paths. `export --run` exports the original ready run. Add `--variant NAME_FROM_RENDER` to export a chosen variant. Export verifies the selected video hash and refuses an existing destination video. It creates local MP4 + JSON metadata, not a SimplePost API payload.

No command invokes SimplePost, Telegram or a social network. Supplying `--execute` authorizes image generation only.
