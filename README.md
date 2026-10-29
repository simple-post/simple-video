# Simple Video

Create short, captioned photo-parallax videos from your own images or AI-generated photos. Run the entire workflow from a terminal or an AI agent: plan, generate, animate, add music, validate, and export.

**Early release: `@simple-post/video`.** This repository remains private for now; the npm package is public. No account, hosted service, VPS, or n8n installation is required. Image generation uses your own OpenAI API key. Local-photo rendering needs no API key.

## Install and make a video

Requires Node.js 24+ and FFmpeg/ffprobe (with libx264). On macOS: `brew install ffmpeg`. On Debian/Ubuntu: `sudo apt-get install ffmpeg fonts-liberation`.

```sh
npm install -g @simple-post/video
simple-video --version

# One-time renderer installation; review its plan and confirm.
simple-video setup
simple-video auth login

# Say what image you want. This saves a recipe; no API call yet.
simple-video init ./my-video \
  --prompt "A T. rex reaching for a coffee cup on a cafe counter, realistic photo with layered depth" \
  --duration 6
simple-video --project ./my-video plan

# --execute authorizes the planned image-generation request.
simple-video --project ./my-video create --id first-video --execute
simple-video --project ./my-video export --run first-video --output ./review
```

Alternatively invoke the CLI without a global install:

```sh
npx --yes --package @simple-post/video simple-video --help
```

Open the exported MP4 to review it. `init` defaults to one photo; in a terminal without `--prompt`, it asks what image you want. The description is saved as `prompt` in `my-video/simple-video.json`, and `plan` displays it before generation. Use `--caption "Your text"` to add optional on-screen text.

For a free renderer-only test, run `simple-video init ./local-demo --template slideshow --local`, then create without `--execute`. `--local` creates geometric demo artwork; it does not generate a dinosaur or interpret an image prompt. To import your own photos, edit `image.files` in the recipe.

Installing the npm package does not install Python or download the DepthFlow environment. Setup may download several GB; it shows its plan and asks for approval before downloading or installing anything. Press Enter or answer `n` to cancel. For unattended installation, review `setup --dry-run --json` first, then run `setup --yes --storage env --json --no-input`.

For development from the private source checkout:

```sh
git clone https://github.com/simple-post/simple-video.git
cd simple-video
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
node bin/run.js --help
```

`npm link --ignore-scripts` optionally makes the development command available. Source commands use `node bin/run.js` in place of `simple-video`.

## Choose your images

```sh
simple-video init ./story --template slideshow \
  --prompt "A triceratops trying to enter a small gym, layered realistic photo" \
  --prompt "The same triceratops wedged in the gym doorway, realistic photo" \
  --caption "First day" --caption "Small problem" --duration 3

simple-video init ./battle --template comparison \
  --hero "A T. rex" --opponent "woolly mammoths" \
  --setting "An open snowy valley"
```

Use one `--prompt` per photo. A single-photo recipe stores it in `prompt`; slideshows/challenges store each description in `shots[].prompt`. Comparisons store `hero`, `opponent`, `environment` and round settings. You can edit these in `simple-video.json` after initialization. `--example` deliberately creates a preset starter recipe to edit; unattended initialization otherwise requires descriptions. Creating a recipe never makes a paid call.

The default image model is `gpt-image-2.5-flare`; set `image.model` explicitly to select another compatible GPT Image model. Linked slides use the preceding image as an editing reference. Your key must have access to the selected model. [Official image API documentation](https://developers.openai.com/api/docs/guides/image-generation).

## Choose credential storage

Both `setup` and `auth login` ask where keys should be kept: the native OS store (recommended), an explicit private file, or environment-only mode.

```sh
simple-video setup --auth-only  # storage choice, without runtime downloads
simple-video auth login         # choose storage, then paste a hidden key
simple-video auth status         # inspect source/store, never the key
simple-video auth logout         # remove the selected saved key
```

Native storage uses macOS Keychain, Linux Secret Service or Windows Credential Manager. File mode is explicitly selected and unencrypted; Unix permissions are `0600`/`0700`, while Windows uses the user directory's ACLs. Environment mode saves no key. Unavailable native stores fail with instructions; they never silently downgrade to a file or memory-only store.

For automation, use `auth login --storage keychain --from-env --json --no-input`, or explicitly select `file` or `env`. Environment and explicit `--env-file` values still take precedence over saved keys. To move a version 0.2.0 key file into the native store, use `auth login --storage keychain --migrate-file`; the original is removed only after read-back verification. See [storage, headless use and migration](docs/authentication.md).

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
| `init [directory] --prompt "Image description"` | Describe your photos and save an editable recipe                          |
| `auth login` / `auth status` / `auth logout`    | Save, inspect or remove a key shared across your projects                 |
| `setup [--dry-run] [--skip-model] [--yes]`      | Review and approve managed Python, DepthFlow and local model installation |
| `doctor [--check-render] [--depth]`             | Check dependencies, graphics and optional depth inference                 |
| `schema`                                        | Print the recipe JSON Schema                                              |
| `plan [--recipe file.json]`                     | Validate and inspect images, scenes, duration and cost estimates          |
| `create --id NAME [--execute] [--images-only]`  | Import/generate images and render a resumable run                         |
| `render --run NAME --intensity 0.07`            | Re-render cached photos into a new variant without image-generation calls |
| `status --run NAME` / `list`                    | Read saved progress and request totals                                    |
| `export --run NAME --output DIRECTORY`          | Copy a validated run or variant and its metadata for review/publishing    |
| `skill [--output DIRECTORY]`                    | Locate or copy the included agent skill                                   |

Terminal output uses short, readable progress messages and results. Global flags include `--project`, `--root`, `--home`, `--config-dir`, `--env-file`, `--json`, `--human`, `--quiet`, and `--no-input`. Use `--json --no-input` for agents and scripts: results go to stdout, progress/errors go to stderr, and no prompt appears. Piped stdout also defaults to JSON. Unattended setup requires explicit `--yes`; this does not authorize paid image generation. See the [complete CLI contract](docs/cli.md).

## Files stay on your machine

```text
my-video/
  simple-video.json         # portable recipe; paths relative to this file
  photos/                   # your local input images, when used
  .env                      # optional alternative to saved login; ignored
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
