# CLI contract

In a terminal, commands print readable summaries and progress messages. Setup explains its downloads and locations, then asks for approval with a default of **No**. Other commands do not prompt. No command needs a browser.

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

`--home DIR` selects the managed runtime and wins over `SIMPLE_VIDEO_HOME`. Environment variables supply keys; `--env-file FILE` fills missing supported values only. Environment variables take precedence over file values. No credentials are written by the CLI.

## Planning and paid generation

```sh
simple-video --project ./story schema --json > schema-response.json
simple-video --project ./story plan
simple-video --project ./story create --id episode-01 --dry-run
simple-video --project ./story --env-file ./story/.env create --id episode-01 --execute
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
