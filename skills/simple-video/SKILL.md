---
name: simple-video
description: Create, re-render and export captioned photo-parallax videos with the Simple Video CLI, using local photos or user-configured image generation. Use for slideshow animation, split-screen comparisons, subtle depth motion and reproducible video recipes; publishing belongs to a separate tool.
---

# Simple Video

Use the same CLI as the user, with `--json --no-input` for automation. The npm package is `@simple-post/video` and its binary is `simple-video`. Find it on PATH or invoke `npx --yes --package @simple-post/video simple-video`; in a source checkout, use `node /path/to/simple-video/bin/run.js` after `npm ci` and `npm run build`. In JSON mode successful commands emit one result on stdout. Progress/errors use stderr; a nonzero exit means inspect the error before retrying. Terminals otherwise default to readable text. Help and version remain plain text.

## Discover and prepare

- Run `--help`, `COMMAND --help`, and `schema` when flags or recipe fields are uncertain. The schema is in the JSON response's `data` property. Do not invent command flags or send arbitrary SimplePost API payloads to this CLI.
- Select `--project DIR` consistently; all photos, audio and keys belong to that project/user. The default recipe is `DIR/simple-video.json`. Recipe-relative file paths work from any invocation directory.
- `init DIR --prompt "Image description" --json --no-input` creates a single-photo recipe (the default) without generating. Repeat `--prompt` with `--template slideshow` or `challenge` for 2–12 photos; optional repeated `--caption` adds text, and `--duration` is per photo. Comparisons take `--hero`, `--opponent` and `--setting`. Missing descriptions return `INPUT_REQUIRED`; do not silently select example content. `--example` deliberately requests preset descriptions for editing. `--local` creates geometric demo artwork and cannot generate a described subject.
- `doctor` checks dependencies and key presence. `setup --dry-run --json --no-input` describes downloads, sizes and locations without changes. When runtime installation is within the user's authorized scope, use `setup --yes --json --no-input` to install managed Python/DepthFlow and local depth weights. Setup without `--yes` returns `CONFIRMATION_REQUIRED` in automation; it must not hang or implicitly approve. `--yes` authorizes runtime setup only, not paid generation. `doctor --check-render` checks actual GPU rendering without a paid API call. `--home` consistently selects a nondefault runtime.
- `auth status --json --no-input` reports whether a key is configured and its source, never its value. Generation uses the environment first, then explicit `--env-file`, then saved Simple Video credentials. The user can run `auth login` to paste a hidden key once. When persistent credential setup is authorized, `auth login --from-env --json --no-input` or `--stdin` imports without a key-value argument; explain the destination before storing. The config file is unencrypted, private on Unix (`0700` directory, `0600` file), and separate from projects/runtime; `--config-dir` or `SIMPLE_VIDEO_CONFIG_DIR` overrides it. Do not discover keys in unrelated projects or print them. Local photos need no key; auth commands make no API request and do not validate credit/model access.

## Make and iterate

1. Write/edit the recipe, then run `plan`. Check exact asset IDs, image count, duration, budget and source photos. `image.files` maps every asset ID to a local path; omit it for OpenAI generation. Do not mix provider modes in one create.
2. Use a stable descriptive `--id`. `create --id NAME` imports local photos; generated photos require `--execute`. Use the user's authorized generation scope and budget. Planning and credential setup alone do not authorize spending.
3. To inspect photos first, use `create --id NAME --execute --images-only`, then run the same command without `--images-only` to render cached images. For local files omit `--execute`.
4. Inspect the reported MP4/contact sheet. Adjust motion or audio with `render --run NAME --intensity 0.07` or `--soundtrack FILE`; these reuse verified images and make no image-generation calls. Depth weights can download locally if missing.
5. Export the chosen validated result with `export --run NAME --output DIR`; for a variant add `--variant NAME_FROM_RENDER`. Keep credits from the export manifest. Give the user the resulting local file and any material limitations.

## Invariants that matter

- Prefer the subtle DepthFlow preset: story intensity `0.105`, comparison `0.15`, or lower when edges stretch. Keep duration unchanged when reducing travel. Use `pan`/`diagonal` without mid-shot reversal. `alternateDirections` changes direction only at cuts. The CPU renderer is a visibly different, explicit option; do not silently substitute it when graphics setup fails.
- Keep music dominant, select a catchy source excerpt and add quiet effects only for specific visible events. Use licensed user-supplied audio and preserve attribution. No trend recording is included by the package.
- Comparison templates with `winnerPattern: "final-flip"` keep the same winning side until the final round. Increase challenger counts; do not reveal the switch early.
- Repeat an unchanged run ID to resume. Changed recipes use a new ID; shared verified photos are reused. Never automatically loop `--retry-uncertain`: inspect the persisted state/provider first, since another request may duplicate a charge. It also requires paid-generation authorization and budget.
- Do not delete caches, overwrite source photos or edit receipts to force a retry. Read `status` and the structured error. Export refuses an existing destination video.
- This CLI never publishes or sends previews externally. A user's request to generate is not permission to post. Use SimplePost separately when publishing is requested, and retain the generated media's credits.

For complete flags, error codes and recovery, read [CLI reference](../../docs/cli.md) in the source repository. If this skill was copied alone, use `--help` and `schema` as the source of truth; the maintained docs are at https://github.com/simple-post/simple-video/tree/main/docs.
