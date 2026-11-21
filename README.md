# Simple Video

Tell your AI agent what video you want. It turns your brief into an editable recipe, uses your photos or generates new ones, adds subtle depth motion, and returns a vertical MP4 you can review. The agent runs the CLI from the same machine as your files.

## Start by asking your agent

Paste one of these into a terminal-capable agent such as Codex:

> Use `@simple-post/video` to make a 9-second vertical parallax video of a tiny robot trying to order coffee. Create three realistic photos with a consistent character and use short captions. Keep the motion subtle. Give me the MP4 and the editable recipe.

> Use `@simple-post/video` to make a 12-second parallax slideshow from the four photos in my `Trip photos` folder, in filename order. Keep faces in frame and leave the video silent. Give me the finished MP4.

For a free first run, ask it to make a demo with the built-in artwork. For a matchup, name the two sides and tell the agent if you want the winner to change on the last round. For music, point it at a local track you have permission to use and describe the desired timing.

## What you’ll do once

- **Approve renderer setup if needed.** Your agent can check the environment, show you the proposed downloads, and run setup after approval. You need Node.js 24+, FFmpeg with ffprobe and libx264, and a working OpenGL context for the default renderer. The managed Python environment and depth weights can take several GB.
- **Add an OpenAI key if you want AI-generated photos.** Run `simple-video auth login` in a terminal and enter the key at the hidden prompt. Choose the native OS store to reuse it across projects, or use a secret manager or environment variable for unattended jobs. Local photos and the demo work without a key.

Once set up, give the agent the brief. It can pick the layout, write the prompts or order the photos, validate the plan, render, fix visual issues using the same images, and return the finished file. The CLI creates the video locally. It sends image-generation requests to OpenAI only if the agent runs generation with `--execute`.

## Give your agent the instructions

It can read the bundled skill straight from npm, even on a machine without a global install:

```sh
npx --yes --package @simple-post/video simple-video skill --print
```

To make the skill discoverable in Codex, run this once from the project directory. Start a new session if the current session hasn’t picked it up yet.

```sh
npx --yes --package @simple-post/video simple-video skill --output .agents/skills/simple-video
```

Then say, for example, “Use `$simple-video` to make a 9-second slideshow from these photos.” If you use another agent with skill support, give it the same skill folder using that agent’s installation path. An agent that can run terminal commands can also read `skill --print` on demand.

## Commands your agent runs

Install the CLI if you prefer a command on PATH:

```sh
npm install -g @simple-post/video
simple-video --version
```

Check a machine or prepare the renderer:

```sh
simple-video doctor --runtime-only --json --no-input
simple-video setup --runtime-only --dry-run --json --no-input
# After approval, if the renderer is missing:
simple-video setup --runtime-only --yes --json --no-input
simple-video doctor --runtime-only --check-render --json --no-input
```

For an original photo, the agent writes the description itself:

```sh
simple-video init ./coffee --json --no-input \
  --name "Coffee Break" --duration 6 \
  --prompt "A tiny red robot standing at a busy cafe counter, warm window light, clear foreground and background"
simple-video --project ./coffee plan --json --no-input
simple-video --project ./coffee create --id coffee-break --execute \
  --output ./finished --json --no-input
```

For supplied photos, the agent passes them in the desired order. One photo creates a single scene. Multiple photos create a slideshow.

```sh
simple-video init ./trip --json --no-input \
  --name "A Weekend Away" --duration 3 \
  --photo "./Trip photos/01.jpg" --photo "./Trip photos/02.jpg" --photo "./Trip photos/03.jpg"
simple-video --project ./trip create --id weekend --output ./finished --json --no-input
```

For a comparison, start with `init --template comparison --hero "A red fox" --opponent "Arctic foxes" --setting "A rocky tundra valley"`. For customized scenes and music, the agent can edit the recipe and check the supported fields with `simple-video schema --json` and `plan`. A comparison alternates split screens and result photos. The template keeps the same winner through the penultimate round.

The agent reads the exported path at `data.export.video` and checks the contact sheet at `data.contactSheet`. `--json --no-input` prints a structured result on stdout and progress or errors on stderr. It never prompts. For a render interrupted during generation, resume with the same recipe and run ID. An unknown outcome from the image API needs investigation before a retry that could incur another charge.

## Files and limits

- `simple-video.json` is the editable recipe. Input paths in it are relative to that file. `init --photo` references the original photos in place.
- `.simple-video/` in the project holds generated photos, cached renders, contact sheets and run records.
- `create --output DIR` writes the finished MP4 and a JSON manifest to the chosen folder. Use `render --run ID --intensity 0.07` to reduce motion using the existing photos, then `export --run ID --variant VARIANT --output DIR` to export the revised cut.
- The parallax effect adds camera motion to still photographs. Stronger motion can stretch edges. Music is optional and new projects are silent by default.
- Your agent can pass the finished MP4 to SimplePost when you ask it to publish or schedule. Video generation and exporting require no SimplePost account.

The npm package is public. The GitHub source repository is currently private. See the package’s `docs/` folder for the [CLI contract](docs/cli.md), [renderer setup](docs/setup.md), [recipes and music](docs/recipes.md), and [credential storage](docs/authentication.md). The TypeScript CLI is MIT licensed. DepthFlow is installed separately under AGPL-3.0. See [third-party notices](THIRD_PARTY_NOTICES.md).
