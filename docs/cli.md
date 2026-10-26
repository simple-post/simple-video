# CLI contract

All commands work without stdin, prompts or a browser. `simple-video` and `simple-video --help` print help; `--version` prints the version. Other successful commands emit exactly one JSON result on stdout:

```json
{
  "ok": true,
  "command": "create",
  "data": { "id": "first-video", "status": "ready" }
}
```

The actual `data` contains the command's complete result. `--json` explicitly selects the default JSON behavior. `--no-input` makes the non-interactive contract explicit; it never changes authorization. `--quiet` suppresses progress, not errors. Progress uses newline-delimited JSON on stderr:

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

| Exit | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Success; inspect `executed` for a plan-only create/setup |
| 1    | Operation, conflict, or filesystem failure               |
| 2    | Invalid command arguments or recipe schema               |
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
simple-video --project ./story schema > schema-response.json
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
