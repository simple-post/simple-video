import { Command, CommanderError, Option } from "commander";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { readdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SpecSchema, planExperiment } from "./spec.js";
import { CliError, command, readJson, safeError, safeId } from "./io.js";
import { runExperiment, requestTotals, type Run } from "./runner.js";
import {
  LocalImages,
  OpenAIImages,
  FixtureImages,
  loadEnv,
} from "./provider.js";
import { rerender } from "./rerender.js";
import {
  initProject,
  readRecipe,
  recipePlan,
  exportRun,
  type InitContent,
} from "./project.js";
import {
  credentialsPath,
  saveKey,
  keyStatus,
  loadSavedKey,
  logout,
  keyFromStdin,
  storage,
  storageInfo,
  storageChoices,
  selection,
  configureStorage,
  authPlan,
  legacyFilePresent,
  migrateFile,
  type Storage,
} from "./auth.js";
import {
  runtimePaths,
  setup,
  setupPlan,
  probeGraphics,
  exists,
} from "./runtime.js";
import {
  Terminal,
  canConfirm,
  confirmSetup,
  setupPreview,
  askText,
} from "./terminal.js";

const program = new Command()
  .name("simple-video")
  .description(
    "Create photo-parallax videos. Readable terminal output; use --json for automation. Setup asks before installing. No automatic publishing.",
  )
  .version(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version,
  )
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
    "--config-dir <directory>",
    "saved-login directory (or SIMPLE_VIDEO_CONFIG_DIR)",
  )
  .addOption(
    new Option(
      "--json",
      "machine-readable results and progress; never prompt",
    ).conflicts("human"),
  )
  .addOption(
    new Option("--human", "readable output even when piped").conflicts("json"),
  )
  .option("--no-input", "never prompt; unattended setup also requires --yes")
  .option("--quiet", "suppress progress events on stderr");
program.exitOverride().configureOutput({ writeErr: () => {} });
const opts = () =>
  program.opts<{
    project: string;
    root?: string;
    home?: string;
    envFile?: string;
    configDir?: string;
    quiet?: boolean;
    json?: boolean;
    human?: boolean;
    input?: boolean;
  }>();
const project = () => resolve(opts().project);
const root = () => resolve(opts().root ?? join(project(), ".simple-video"));
const recipe = (path?: string) =>
  resolve(project(), path ?? "simple-video.json");
const terminal = new Terminal(opts);
const log = (event: unknown) => terminal.log(event);
const result = (data: unknown): void =>
  terminal.result(
    program.args[0] === "auth"
      ? program.args.slice(0, 2).join(" ")
      : (program.args[0] ?? "help"),
    data,
  );
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
  if (opts().configDir)
    process.env.SIMPLE_VIDEO_CONFIG_DIR = resolve(opts().configDir!);
}
program.hook("preAction", configure);
const interactive = () =>
  canConfirm(
    opts(),
    terminal.json,
    Boolean(process.stdin.isTTY),
    Boolean(process.stderr.isTTY),
  );
const collect = (value: string, previous: string[]) => [...previous, value];
async function chooseStorage(requested?: string): Promise<Storage> {
  if (requested) return storage(requested);
  const current = await selection();
  if (!interactive()) {
    if (current) return current;
    throw new CliError(
      "STORAGE_SELECTION_REQUIRED",
      2,
      "Choose --storage keychain, --storage file or --storage env. No key or preference was saved.",
      await authPlan(),
    );
  }
  const choices = storageChoices(),
    defaultIndex = Math.max(
      0,
      choices.findIndex((c) => c.storage === current),
    );
  process.stderr.write(
    "\nHow should Simple Video access your OpenAI key?\n" +
      choices
        .map(
          (c, i) =>
            `  ${i + 1}. ${c.label}${c.recommended ? " (recommended)" : ""}`,
        )
        .join("\n") +
      "\n",
  );
  while (true) {
    const answer = await askText(`Choose storage [${defaultIndex + 1}]: `),
      choice = choices[Number(answer || defaultIndex + 1) - 1];
    if (choice) return choice.storage;
    process.stderr.write("Choose one of the listed numbers.\n");
  }
}
const storageOption = () =>
  new Option(
    "--storage <backend>",
    "keychain (native OS store), file (unencrypted), or env (no saved key)",
  ).choices(["keychain", "file", "env"]);
function explainStorage(chosen: Storage) {
  if (terminal.json) return;
  const info = storageInfo(chosen);
  process.stderr.write(
    `\nStorage: ${info.label}\n${"path" in info ? `  Location: ${info.path}\n  File is unencrypted; private Unix permissions are enforced.\n` : "service" in info ? `  Service: ${info.service}\n  Account: ${info.account}\n  Your OS may request permission or unlock. No file fallback.\n` : "  Set OPENAI_API_KEY in your shell or secret manager, or use --env-file.\n  Simple Video will not persist the key.\n"}`,
  );
}

const auth = program
  .command("auth")
  .description(
    "Save an OpenAI key once for this computer; inspect or remove the saved login",
  );
auth
  .command("login")
  .description(
    "Paste a hidden key, or import it explicitly from stdin/environment; no API request",
  )
  .addOption(
    new Option(
      "--stdin",
      "read the key from piped stdin, never a command-line argument",
    ).conflicts("fromEnv"),
  )
  .addOption(
    new Option(
      "--from-env",
      "save OPENAI_API_KEY from the environment or explicit --env-file",
    ).conflicts("stdin"),
  )
  .addOption(storageOption())
  .addOption(
    new Option(
      "--migrate-file",
      "move the existing file key to the OS store, verify it, then remove the file",
    ).conflicts(["stdin", "fromEnv"]),
  )
  .action(async (o) => {
    const chosen = await chooseStorage(o.storage);
    explainStorage(chosen);
    if (chosen === "env") {
      if (o.stdin || o.fromEnv || o.migrateFile)
        throw new CliError(
          "INVALID_INPUT",
          2,
          "Environment storage does not import or save keys; omit input-source flags.",
        );
      const preference = await configureStorage(chosen);
      result({
        ...preference,
        saved: false,
        configured: Boolean(process.env.OPENAI_API_KEY),
        validatedWithProvider: false,
      });
      return;
    }
    let migrate = Boolean(o.migrateFile);
    if (
      !migrate &&
      chosen === "keychain" &&
      !o.stdin &&
      !o.fromEnv &&
      interactive() &&
      (await legacyFilePresent())
    ) {
      process.stderr.write(
        "An existing file-based key was found. Move it into the OS store, verify it, then delete the file?\n",
      );
      migrate = await confirmSetup(
        process.stdin,
        process.stderr,
        "Migrate and remove the original file? [y/N] ",
      );
    }
    if (migrate) {
      result(await migrateFile(chosen));
      return;
    }
    let key: string;
    if (o.stdin) {
      if (process.stdin.isTTY)
        throw new CliError(
          "INVALID_INPUT",
          2,
          "--stdin needs piped input. Run auth login without flags for a hidden prompt.",
        );
      key = await keyFromStdin();
    } else if (o.fromEnv) {
      key = process.env.OPENAI_API_KEY ?? "";
    } else {
      if (!interactive())
        throw new CliError(
          "INPUT_REQUIRED",
          2,
          "Run simple-video auth login in a terminal to paste your key privately, or use --from-env / --stdin for automation.",
        );
      process.stderr.write(
        "The key is reused across projects. No provider API request is made.\n",
      );
      key = await askText("OpenAI API key (hidden): ", true);
    }
    result(await saveKey(key, chosen));
  });
auth
  .command("status")
  .description("Show credential source and location, never the key")
  .action(async () => result(await keyStatus(opts().envFile)));
auth
  .command("logout")
  .description(
    "Remove the saved local key; leave environment/env files unchanged",
  )
  .addOption(storageOption())
  .action(async (o) =>
    result(await logout(o.storage ? storage(o.storage) : undefined)),
  );

program
  .command("init")
  .description(
    "Describe your photos and create an editable recipe; makes no API calls",
  )
  .argument("[directory]", "destination (default: --project)")
  .option(
    "--template <name>",
    "single (default), slideshow, comparison or challenge",
  )
  .option(
    "--prompt <text>",
    "describe a photo; repeat for each slideshow/challenge photo",
    collect,
    [],
  )
  .option(
    "--caption <text>",
    "optional on-screen text; repeat once per photo",
    collect,
    [],
  )
  .option(
    "--duration <seconds>",
    "seconds per photo (single: 6; slideshow/challenge: 3)",
    number,
  )
  .option("--name <text>", "project title")
  .option("--hero <text>", "comparison: fixed side, such as a T. rex")
  .option(
    "--opponent <text>",
    "comparison: challengers, such as woolly mammoths",
  )
  .option("--setting <text>", "comparison: where the matchup takes place")
  .option(
    "--example",
    "write an editable example with preset image descriptions; do not generate",
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
    const type = types[(o.template ?? "single") as keyof typeof types];
    if (!type)
      throw Error(
        "Unknown template; use slideshow, comparison, single or challenge",
      );
    const content: InitContent = {
      prompts: o.prompt,
      captions: o.caption,
      duration: o.duration,
      name: o.name,
      hero: o.hero,
      opponent: o.opponent,
      setting: o.setting,
    };
    if (!o.local && !o.example) {
      if (type === "battle") {
        for (const [field, label] of [
          ["hero", "Who is the fixed side? "],
          ["opponent", "Who are the challengers? "],
          ["setting", "Where does the matchup take place? "],
        ] as const) {
          if (!content[field]) {
            if (!interactive())
              throw new CliError(
                "INPUT_REQUIRED",
                2,
                "Comparisons need --hero, --opponent and --setting, or --example to edit a starter recipe.",
              );
            content[field] = await askText(label);
          }
        }
      } else if (!content.prompts?.length) {
        if (!interactive())
          throw new CliError(
            "INPUT_REQUIRED",
            2,
            "Describe the image with --prompt. Repeat --prompt for a slideshow; use --local for geometric demo photos, or --example for an editable starter.",
          );
        const count = type === "loop" ? 1 : 3;
        process.stderr.write(
          "Describe what each photo should show. This only saves the recipe.\n",
        );
        content.prompts = [];
        for (let i = 0; i < count; i++)
          content.prompts.push(
            await askText(
              count === 1
                ? "What image would you like? "
                : `Photo ${i + 1} of ${count}: `,
            ),
          );
      }
    }
    result(await initProject(dir ?? project(), type, o.local, content));
  });
program
  .command("setup")
  .description(
    "Review downloads/locations and confirm before installing isolated Python, DepthFlow and model weights. Use --yes for unattended setup.",
  )
  .option(
    "--dry-run",
    "print exact downloads and locations without changing anything",
  )
  .option("--skip-model", "defer depth-model download until the first render")
  .option("-y, --yes", "approve the displayed setup plan without prompting")
  .option("--uv <executable>", "use an existing uv instead of downloading it")
  .option("--python <version>", "managed Python version", "3.12")
  .addOption(storageOption())
  .option(
    "--auth-only",
    "choose credential storage without installing the renderer or entering a key",
  )
  .action(async (o) => {
    if (o.dryRun) {
      result({
        ...(o.authOnly
          ? { executed: false }
          : await setup({ ...o, dryRun: true })),
        authOnly: Boolean(o.authOnly),
        authentication: await authPlan(
          o.storage ? storage(o.storage) : undefined,
        ),
      });
      return;
    }
    if (o.authOnly) {
      const chosen = await chooseStorage(o.storage);
      explainStorage(chosen);
      result({
        executed: true,
        authOnly: true,
        authentication: await configureStorage(chosen),
        next: "simple-video auth login",
      });
      return;
    }
    const plan = setupPlan(o);
    let approved = Boolean(o.yes);
    if (!o.dryRun && !terminal.json)
      process.stderr.write(setupPreview(plan) + "\n");
    if (
      !o.dryRun &&
      !approved &&
      canConfirm(
        opts(),
        terminal.json,
        Boolean(process.stdin.isTTY),
        Boolean(process.stderr.isTTY),
      )
    ) {
      approved = await confirmSetup();
      if (!approved) {
        result({ ...plan, executed: false, cancelled: true });
        return;
      }
    }
    if (!approved) {
      await setup({ ...o, approved: false });
      return;
    }
    const chosen = await chooseStorage(o.storage);
    explainStorage(chosen);
    const installed = await setup({ ...o, approved, log });
    result({ ...installed, authentication: await configureStorage(chosen) });
  });

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
    const auth = await keyStatus(opts().envFile);
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
      openaiKeyPresent: auth.configured,
      authentication: auth,
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
            ? "Run simple-video auth login once (or use OPENAI_API_KEY / --env-file), then add --execute to authorize generation"
            : "Omit --dry-run to render",
      });
      return;
    }
    if (name === "openai") await loadSavedKey();
    if (name === "openai" && !process.env.OPENAI_API_KEY)
      throw Error(
        "OpenAI API key is missing. Run simple-video auth login once, or supply OPENAI_API_KEY through the environment or --env-file.",
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
      terminal.error({
        code,
        message,
        ...(error instanceof CliError && error.details
          ? { details: error.details }
          : {}),
        ...(error instanceof z.ZodError
          ? {
              issues: error.issues.map(({ path, message }) => ({
                path,
                message,
              })),
            }
          : {}),
      });
      process.exitCode = exitCode;
    }
  }
}
function classifyError(error: unknown) {
  if (error instanceof CliError)
    return { code: error.code, exitCode: error.exitCode };
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
