import { Command, CommanderError } from "commander";
import { resolve, join } from "node:path";
import { readdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SpecSchema, planExperiment } from "./spec.js";
import { command, readJson, safeError, safeId } from "./io.js";
import { runExperiment, requestTotals, type Run } from "./runner.js";
import {
  LocalImages,
  OpenAIImages,
  FixtureImages,
  loadEnv,
} from "./provider.js";
import { rerender } from "./rerender.js";
import { initProject, readRecipe, recipePlan, exportRun } from "./project.js";
import { runtimePaths, setup, probeGraphics, exists } from "./runtime.js";

const program = new Command()
  .name("simple-video")
  .description(
    "Create photo-parallax videos. No prompts, browser login, or automatic publishing. JSON on stdout; progress on stderr.",
  )
  .version("0.1.0")
  .option("--project <directory>", "project directory", ".")
  .option(
    "--root <directory>",
    "asset/cache directory (default: PROJECT/.simple-video)",
  )
  .option(
    "--home <directory>",
    "managed Python/model cache (or SIMPLE_VIDEO_HOME)",
  )
  .option(
    "--env-file <path>",
    "read your credentials from this file; never copies them",
  )
  .option(
    "--json",
    "explicitly request machine-readable JSON (also the default)",
  )
  .option(
    "--no-input",
    "never prompt (all commands already run non-interactively)",
  )
  .option("--quiet", "suppress progress events on stderr");
program.exitOverride().configureOutput({ writeErr: () => {} });
const opts = () =>
  program.opts<{
    project: string;
    root?: string;
    home?: string;
    envFile?: string;
    quiet?: boolean;
  }>();
const project = () => resolve(opts().project);
const root = () => resolve(opts().root ?? join(project(), ".simple-video"));
const recipe = (path?: string) =>
  resolve(project(), path ?? "simple-video.json");
const log = (event: unknown) => {
  if (!opts().quiet)
    process.stderr.write(
      JSON.stringify({ event: "progress", ...(event as object) }) + "\n",
    );
};
const result = (data: unknown): void => {
  process.stdout.write(
    JSON.stringify(
      { ok: true, command: program.args[0] ?? "help", data },
      null,
      2,
    ) + "\n",
  );
};
const number = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Expected a finite number");
  return parsed;
};
const summary = (r: Run) => ({
  id: r.id,
  name: r.plan.name,
  status: r.status,
  provider: r.provider,
  output: r.output,
  report: r.report,
  ...requestTotals(r),
  error: r.error,
});
async function configure() {
  if (opts().home) process.env.SIMPLE_VIDEO_HOME = resolve(opts().home!);
  if (opts().envFile) await loadEnv(resolve(opts().envFile!));
}
program.hook("preAction", configure);

program
  .command("init")
  .description(
    "Create a project recipe and credential example; makes no API calls",
  )
  .argument("[directory]", "destination (default: --project)")
  .option(
    "--template <name>",
    "slideshow, comparison, single or challenge",
    "slideshow",
  )
  .option(
    "--local",
    "include original geometric demo photos; no API key needed",
  )
  .action(async (dir, o) => {
    const types = {
      slideshow: "story",
      comparison: "battle",
      single: "loop",
      challenge: "challenge",
    } as const;
    const type = types[o.template as keyof typeof types];
    if (!type)
      throw Error(
        "Unknown template; use slideshow, comparison, single or challenge",
      );
    result(await initProject(dir ?? project(), type, o.local));
  });
program
  .command("setup")
  .description(
    "Install isolated Python and DepthFlow; downloads model weights unless --skip-model. Does not install system GPU drivers or FFmpeg.",
  )
  .option(
    "--dry-run",
    "print exact downloads and locations without changing anything",
  )
  .option("--skip-model", "defer depth-model download until the first render")
  .option("--uv <executable>", "use an existing uv instead of downloading it")
  .option("--python <version>", "managed Python version", "3.12")
  .action(async (o) => result(await setup({ ...o, log })));

program
  .command("doctor")
  .description(
    "Check dependencies and key presence without a paid API request; exits 3 if dependencies are missing",
  )
  .option(
    "--check-render",
    "test the actual GPU/OpenGL renderer with supplied synthetic depth; no model downloads",
  )
  .option("--depth", "load/download and test the local depth model")
  .action(async (o) => {
    const paths = runtimePaths();
    const checks = await Promise.all(
      ["ffmpeg", "ffprobe"].map(async (name) => ({
        name,
        available: await command(name, ["-version"]).then(
          () => true,
          () => false,
        ),
      })),
    );
    const binary = process.env.SIMPLE_VIDEO_DEPTHFLOW ?? paths.depthflow;
    const depthflowPresent = await exists(binary);
    if (o.depth) {
      log({ stage: "doctor", step: "depth-model" });
      await (await import("./depth.js")).prepareDepth(paths.models);
    }
    const graphics = o.checkRender ? await probeGraphics() : undefined;
    const ready = checks.every((c) => c.available) && depthflowPresent;
    result({
      ready,
      node: process.version,
      checks,
      depthflowPresent,
      graphics,
      paths,
      root: root(),
      openaiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
      publishing: false,
      hint: ready
        ? "Use doctor --check-render to verify GPU rendering"
        : "Run simple-video setup; install ffmpeg/ffprobe separately if missing",
    });
    if (!ready) process.exitCode = 3;
  });

program
  .command("schema")
  .description("Print the strict recipe JSON Schema for editors and AI agents")
  .action(() => result(z.toJSONSchema(SpecSchema, { io: "input" })));
program
  .command("plan")
  .description(
    "Validate a recipe, list its exact image IDs and estimate requests/cost; no downloads or API calls",
  )
  .option("--recipe <file>", "recipe path relative to --project")
  .action(async (o) => result(recipePlan(await readRecipe(recipe(o.recipe)))));
program
  .command("create")
  .description(
    "Generate/import photos and render a validated video. Paid generation requires --execute; otherwise returns a plan",
  )
  .option("--recipe <file>", "recipe path relative to --project")
  .requiredOption(
    "--id <id>",
    "stable run ID; repeat it to resume without regenerating completed photos",
  )
  .option(
    "--provider <name>",
    "openai, local or fixture (default: local when image.files exists)",
  )
  .option(
    "--execute",
    "authorize the recipe's paid image requests; not needed for local photos",
  )
  .option("--dry-run", "return the plan without generating or rendering")
  .option("--images-only", "generate/import images and stop before rendering")
  .option(
    "--retry-uncertain",
    "accept possible duplicate charges for a previously interrupted request",
  )
  .action(async (o) => {
    safeId(o.id);
    const spec = await readRecipe(recipe(o.recipe)),
      name = o.provider ?? (spec.image.files ? "local" : "openai");
    if (!["openai", "local", "fixture"].includes(name))
      throw Error("Provider must be openai, local or fixture");
    if (name === "openai" && spec.image.files)
      throw Error(
        "Recipe contains local files; remove image.files before using the openai provider",
      );
    if (o.dryRun || (name === "openai" && !o.execute)) {
      result({
        executed: false,
        ...recipePlan(spec),
        provider: name,
        next:
          name === "openai"
            ? "Supply your own OPENAI_API_KEY and add --execute to authorize generation"
            : "Omit --dry-run to render",
      });
      return;
    }
    if (name === "openai" && !process.env.OPENAI_API_KEY)
      throw Error(
        "OPENAI_API_KEY is missing. Supply your own key through the environment or --env-file; no credentials are bundled.",
      );
    const provider =
      name === "local"
        ? await LocalImages.fromSpec(
            spec,
            planExperiment(spec).assets.map((a) => a.id),
          )
        : name === "fixture"
          ? new FixtureImages()
          : new OpenAIImages();
    result(
      summary(
        await runExperiment(spec, provider, {
          root: root(),
          id: o.id,
          imagesOnly: o.imagesOnly,
          retryUncertain: o.retryUncertain,
          log,
        }),
      ),
    );
  });

program
  .command("render")
  .description(
    "Render a new variant from verified cached photos; never calls an image API",
  )
  .requiredOption("--run <id>", "source run ID")
  .option("--motion <name>", "parallax, zoom or static", "parallax")
  .option("--engine <name>", "depthflow or cpu (default: retain source)")
  .option(
    "--intensity <number>",
    "DepthFlow camera travel, 0.01–0.5; subtle preset is 0.105",
    number,
  )
  .option("--strength <number>", "CPU renderer amplitude, 0.01–0.07", number)
  .option(
    "--soundtrack <file>",
    "licensed soundtrack JSON, with paths relative to that file",
  )
  .action(async (o) => {
    const motion = z.enum(["parallax", "zoom", "static"]).parse(o.motion);
    let soundtrack;
    if (o.soundtrack) {
      const { SoundtrackSchema } = await import("./soundtrack.js");
      const path = resolve(o.soundtrack),
        { dirname } = await import("node:path");
      soundtrack = SoundtrackSchema.parse(await readJson(path));
      if (soundtrack.track)
        soundtrack.track.file = resolve(dirname(path), soundtrack.track.file);
      for (const cue of soundtrack.recordedCues ?? [])
        cue.file = resolve(dirname(path), cue.file);
    }
    result(
      await rerender(
        o.run,
        {
          motion,
          ...(o.engine
            ? { parallaxEngine: z.enum(["depthflow", "cpu"]).parse(o.engine) }
            : {}),
          ...(o.intensity === undefined
            ? {}
            : { parallaxIntensity: o.intensity }),
          ...(o.strength === undefined ? {} : { parallaxStrength: o.strength }),
        },
        { root: root(), soundtrack, log },
      ),
    );
  });
program
  .command("status")
  .description("Read a saved run; no API calls")
  .requiredOption("--run <id>", "run ID")
  .action(async (o) =>
    result(
      summary(
        await readJson<Run>(resolve(root(), "runs", safeId(o.run), "run.json")),
      ),
    ),
  );
program
  .command("list")
  .description("List saved runs and request totals")
  .action(async () => {
    const dirs = await readdir(resolve(root(), "runs"), {
      withFileTypes: true,
    }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    result(
      await Promise.all(
        dirs
          .filter((d) => d.isDirectory())
          .map(async (d) =>
            summary(
              await readJson<Run>(resolve(root(), "runs", d.name, "run.json")),
            ),
          ),
      ),
    );
  });
program
  .command("export")
  .description(
    "Copy a validated run or render variant to a review/publishing folder; never uploads or posts",
  )
  .requiredOption("--run <id>", "ready run ID")
  .option(
    "--variant <name>",
    "export this render variant instead of the original",
  )
  .requiredOption("--output <directory>", "new export destination")
  .action(async (o) =>
    result(await exportRun(root(), o.run, o.output, o.variant)),
  );
program
  .command("skill")
  .description("Locate or copy the bundled portable agent skill")
  .option("--output <directory>", "copy the skill to this new directory")
  .action(async (o) => {
    const source = fileURLToPath(
      new URL("../skills/simple-video/", import.meta.url),
    );
    if (o.output) {
      if (await exists(resolve(o.output)))
        throw Error("Skill destination already exists");
      await cp(source, resolve(o.output), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    result({
      source,
      destination: o.output ? resolve(o.output) : undefined,
      entry: "SKILL.md",
    });
  });
if (process.argv.length <= 2) program.outputHelp();
else {
  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0)
      process.exitCode = 0;
    else {
      const { code, exitCode } = classifyError(error);
      let message = safeError(error);
      for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "FAL_KEY"]) {
        const secret = process.env[key];
        if (secret) message = message.replaceAll(secret, "[REDACTED]");
      }
      process.stderr.write(
        JSON.stringify({
          ok: false,
          error: {
            code,
            message,
            ...(error instanceof z.ZodError
              ? {
                  issues: error.issues.map(({ path, message }) => ({
                    path,
                    message,
                  })),
                }
              : {}),
          },
        }) + "\n",
      );
      process.exitCode = exitCode;
    }
  }
}
function classifyError(error: unknown) {
  const text = String(error);
  if (error instanceof CommanderError || error instanceof z.ZodError)
    return { code: "INVALID_INPUT", exitCode: 2 };
  if (/uncertain|duplicate charges/i.test(text))
    return { code: "REQUEST_UNCERTAIN", exitCode: 5 };
  if (/budget|request cap/i.test(text))
    return { code: "BUDGET_EXCEEDED", exitCode: 6 };
  if (/missing|ENOENT|OpenGL|GLFW|DepthFlow|EGL|ffmpeg|ffprobe/i.test(text))
    return { code: "SETUP_REQUIRED", exitCode: 3 };
  if (/HTTP|provider|Image request/i.test(text))
    return { code: "PROVIDER_ERROR", exitCode: 4 };
  return { code: "OPERATION_FAILED", exitCode: 1 };
}
