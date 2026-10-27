# Simple Video

Create short, captioned photo-parallax videos from your own images or AI-generated photos. Run the entire workflow from a terminal or an AI agent: plan, generate, animate, add music, validate, and export.

**Early release: `@simple-post/video`.** This repository remains private for now; the npm package is public. No account, hosted service, VPS, or n8n installation is required. Image generation uses your own OpenAI API key. Local-photo rendering needs no API key.

## Install and make a video

Requires Node.js 24+ and FFmpeg/ffprobe (with libx264). On macOS: `brew install ffmpeg`. On Debian/Ubuntu: `sudo apt-get install ffmpeg fonts-liberation`.

```sh
npm install -g @simple-post/video
simple-video --version

# Setup explains downloads, disk usage and locations, then asks to continue (default: No).
simple-video setup --dry-run
simple-video setup
simple-video doctor --check-render

# A complete local demo, with original geometric sample photos. No paid API call.
simple-video init ./my-video --template slideshow --local
simple-video --project ./my-video plan
simple-video --project ./my-video create --id first-video
simple-video --project ./my-video export --run first-video --output ./review
```

Alternatively invoke the CLI without a global install:

```sh
npx --yes --package @simple-post/video simple-video --help
```

Open the exported MP4 to review it. Replace the sample photos with your own images, or generate photos below. Installing the npm package does not install Python or download the DepthFlow environment. Setup may download several GB; it shows its plan and asks for approval before downloading or installing anything. Press Enter or answer `n` to cancel. For unattended installation, review `setup --dry-run --json` first, then run `setup --yes --json --no-input`.

For development from the private source checkout:

```sh
git clone https://github.com/simple-post/simple-video.git
cd simple-video
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
node bin/run.js --help
```

`npm link --ignore-scripts` optionally makes the development command available. Source commands use `node bin/run.js` in place of `simple-video`.

## Generate photos with your own key

```sh
simple-video init ./generated --template slideshow
# Put your own OPENAI_API_KEY in ./generated/.env, or export it in your shell.
# Edit ./generated/simple-video.json: prompts, captions, durations and budget.
simple-video --project ./generated plan

# Without --execute this only returns the plan. Generation is never implicit.
simple-video --project ./generated --env-file ./generated/.env \
  create --id terrier-story --execute
```

The default image model is `gpt-image-2.5-flare`; set `image.model` explicitly to select another compatible GPT Image model. Linked slides use the preceding image as an editing reference. Your key must have access to the selected model. No credentials are included, discovered in other projects, copied, or printed. `--env-file` is explicit; `.env` is not loaded automatically. [Official image API documentation](https://developers.openai.com/api/docs/guides/image-generation).

Budgets enforce request counts and a reservation calculated from your `estimatePerImageUsd`. They are **not a provider-enforced dollar ceiling**. Inspect `plan` before spending. Requests and raw usage are recorded. An interrupted request with an unknown outcome stops rather than automatically charging again; see [recovery](docs/cli.md#resuming-and-recovery).

## What it makes

- **Slideshows:** ordered photos with captions and small, steady depth motion.
- **Comparisons:** independent split-screen panels followed by full-frame result photos. The comparison template switches the winner only on its final round.
- **Single photos:** one image animated for a chosen duration.
- **Challenges:** a sequence of attempts and a result.

These are photo animations, not synthesized moving subjects. DepthFlow is the default renderer. The subtle preset uses intensity `0.105` for stories and `0.15` for comparisons. Motion never reverses inside a shot. Larger movement exposes missing image surfaces and can create artifacts. A simpler CPU renderer, zoom and static modes are also available; their appearance differs from DepthFlow.

## Commands

| Command                                         | Purpose                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `init [directory] --template slideshow --local` | Create an editable project and optional sample photos                     |
| `setup [--dry-run] [--skip-model] [--yes]`      | Review and approve managed Python, DepthFlow and local model installation |
| `doctor [--check-render] [--depth]`             | Check dependencies, graphics and optional depth inference                 |
| `schema`                                        | Print the recipe JSON Schema                                              |
| `plan [--recipe file.json]`                     | Validate and inspect images, scenes, duration and cost estimates          |
| `create --id NAME [--execute] [--images-only]`  | Import/generate images and render a resumable run                         |
| `render --run NAME --intensity 0.07`            | Re-render cached photos into a new variant without image-generation calls |
| `status --run NAME` / `list`                    | Read saved progress and request totals                                    |
| `export --run NAME --output DIRECTORY`          | Copy a validated run or variant and its metadata for review/publishing    |
| `skill [--output DIRECTORY]`                    | Locate or copy the included agent skill                                   |

Terminal output uses short, readable progress messages and results. Global flags include `--project`, `--root`, `--home`, `--env-file`, `--json`, `--human`, `--quiet`, and `--no-input`. Use `--json --no-input` for agents and scripts: results go to stdout, progress/errors go to stderr, and no prompt appears. Piped stdout also defaults to JSON. Unattended setup requires explicit `--yes`; this does not authorize paid image generation. See the [complete CLI contract](docs/cli.md).

## Files stay on your machine

```text
my-video/
  simple-video.json         # portable recipe; paths relative to this file
  photos/                   # your local input images, when used
  .env                      # your key; ignored, never copied
  .simple-video/            # generated assets, receipts, runs and render caches
    runs/first-video/
      run.json
      video.mp4
      contact-sheet.jpg
```

The managed Python environment and model weights use the user's Simple Video cache directory, separate from the source checkout. `--home` or `SIMPLE_VIDEO_HOME` selects another location. `--project` selects the project; `--root` overrides its `.simple-video` data directory. Back up your project, original photos and generated files. Saved run records contain absolute local paths; move finished exports freely, but keep the run workspace in place for resuming.

## Music and publishing

New recipes are silent by default. Add your own licensed music, choose a catchy excerpt using `soundtrack.track.start`, and use sparse, quiet effects for visible events. No commercial recording or trend audio is bundled. See [recipes and audio](docs/recipes.md).

Simple Video exports local media and does not upload, schedule, or publish. After reviewing, use the separate [SimplePost CLI](https://github.com/simple-post/core/tree/main/cli):

```sh
simplepost post --app-account-id YOUR_ACCOUNT_ID \
  --video ./review/first-video.mp4 --text "Your caption and required music credits"
```

That command publishes immediately. Drafts and scheduling belong to SimplePost's API, MCP or web app. Generation does not require a SimplePost account.

## AI agents

The portable skill is in [skills/simple-video/SKILL.md](skills/simple-video/SKILL.md). Copy that folder into your agent's skill directory, or run `simple-video skill --output /path/to/skills/simple-video`. It explains schema discovery, generation authorization, safe resumption and render-only iteration. There is no dependency on a particular agent vendor.

## Development, releases and support

```sh
npm ci
npm test
npm run check
npm run format:check
npm run check:package
```

Tests use mocks, original fixtures and local FFmpeg. They do not make paid generation requests. Native DepthFlow installation and rendering are a separate opt-in check. Apple Silicon macOS has been exercised with a fresh managed runtime and an actual GPU render; other graphics configurations need validation. Releases mirror `core`: push a matching `video-vVERSION` tag, then GitHub Actions checks/tests and publishes via OIDC. See [release instructions](docs/releases.md).

See [setup and platform support](docs/setup.md), [architecture](docs/architecture.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md).

## License

Simple Video's TypeScript code is MIT licensed. The separately installed DepthFlow 0.9.1 runtime is **AGPL-3.0**, by Tremeschin; other dependencies and model weights retain their own licenses. The MIT license does not relicense the renderer, weights or your music. See [third-party notices](THIRD_PARTY_NOTICES.md).
