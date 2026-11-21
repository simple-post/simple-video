import {
  basename,
  dirname,
  resolve,
  join,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import {
  mkdir,
  copyFile,
  writeFile,
  access,
  stat,
  realpath,
} from "node:fs/promises";
import sharp from "sharp";
import { SpecSchema, planExperiment, template, type Spec } from "./spec.js";
import {
  CliError,
  readJson,
  writeJson,
  safeId,
  fileHash,
  stable,
} from "./io.js";
import { type Run } from "./runner.js";

export async function readRecipe(file: string): Promise<Spec> {
  const spec = SpecSchema.parse(await readJson(file)),
    base = dirname(resolve(file));
  if (spec.image.files)
    spec.image.files = Object.fromEntries(
      Object.entries(spec.image.files).map(([id, path]) => [
        id,
        resolve(base, path),
      ]),
    );
  if (spec.soundtrack?.track)
    spec.soundtrack.track.file = resolve(base, spec.soundtrack.track.file);
  for (const cue of spec.soundtrack?.recordedCues ?? [])
    cue.file = resolve(base, cue.file);
  return spec;
}
export function recipePlan(spec: Spec) {
  const plan = planExperiment(spec);
  return {
    ...plan,
    paidImageRequests: spec.image.files ? 0 : plan.assets.length,
    assetIds: plan.assets.map((a) => a.id),
    imageModel: spec.image.model,
    descriptions: describeImages(spec),
    budget: spec.budget,
    estimatedUsd: spec.image.files
      ? 0
      : plan.assets.length * spec.budget.estimatePerImageUsd,
    budgetFits:
      !!spec.image.files ||
      (plan.assets.length <= spec.budget.maxRequests &&
        plan.assets.length * spec.budget.estimatePerImageUsd <=
          spec.budget.maxEstimatedUsd),
    note: "Estimates are user-supplied reservations, not provider-enforced spending limits or an invoice. No API call has been made.",
  };
}
export function describeImages(spec: Spec) {
  if (spec.type === "loop") return [{ id: "loop", prompt: spec.prompt }];
  if (spec.type === "battle")
    return [
      { id: "hero", prompt: spec.heroPrompt ?? spec.hero },
      { id: "challengers", prompt: spec.opponent },
      { id: "setting", prompt: spec.environment },
    ];
  return spec.shots.map((shot, i) => ({
    id: `shot-${i}`,
    prompt: shot.prompt,
  }));
}
export type InitContent = {
  photos?: string[];
  prompts?: string[];
  captions?: string[];
  duration?: number;
  name?: string;
  hero?: string;
  opponent?: string;
  setting?: string;
};
export function customizeTemplate(
  type: Spec["type"],
  content: InitContent,
): Spec {
  const spec = template(type),
    prompts = content.prompts ?? [],
    captions = content.captions ?? [];
  if (content.name !== undefined) spec.name = content.name;
  if (spec.type === "battle") {
    if (prompts.length || captions.length || content.duration !== undefined)
      throw new CliError(
        "INVALID_INPUT",
        2,
        "Comparisons use --hero, --opponent and --setting. Edit rounds and timing in simple-video.json.",
      );
    if (content.hero !== undefined) spec.hero = content.hero;
    if (content.opponent !== undefined) spec.opponent = content.opponent;
    if (content.setting !== undefined) spec.environment = content.setting;
  } else {
    if (content.hero || content.opponent || content.setting)
      throw new CliError(
        "INVALID_INPUT",
        2,
        "--hero, --opponent and --setting are only for --template comparison.",
      );
    if (spec.type === "loop") {
      if (prompts.length > 1 || captions.length > 1)
        throw new CliError(
          "INVALID_INPUT",
          2,
          "A single-photo video takes exactly one --prompt and at most one --caption.",
        );
      if (prompts.length) {
        spec.prompt = prompts[0]!;
        spec.caption = captions[0] ?? "";
      } else if (captions.length) spec.caption = captions[0]!;
      if (content.duration !== undefined) spec.duration = content.duration;
    } else {
      if (prompts.length) {
        if (prompts.length < 2 || prompts.length > 12)
          throw new CliError(
            "INVALID_INPUT",
            2,
            "Slideshows and challenges need 2–12 --prompt flags, one per photo.",
          );
        if (captions.length && captions.length !== prompts.length)
          throw new CliError(
            "INVALID_INPUT",
            2,
            "Provide one --caption per --prompt, or omit captions.",
          );
        spec.shots = prompts.map((prompt, i) => ({
          prompt,
          caption: captions[i] ?? "",
          duration: content.duration ?? 3,
          ...(i ? { referencePrevious: true } : {}),
        }));
        if (spec.type === "story")
          spec.character =
            "Use the subjects described in each shot, preserving continuity where relevant.";
        else spec.question = content.name ?? "What happens next?";
        spec.budget.maxRequests = prompts.length;
        spec.budget.maxEstimatedUsd =
          prompts.length * spec.budget.estimatePerImageUsd;
      } else if (captions.length || content.duration !== undefined)
        throw new CliError(
          "INVALID_INPUT",
          2,
          "Supply --prompt flags before changing slideshow captions or duration.",
        );
    }
  }
  if (prompts.length || content.hero || content.opponent)
    spec.name = content.name ?? "My video";
  return SpecSchema.parse(spec);
}
export async function initProject(
  directory: string,
  type: Spec["type"],
  local = false,
  content: InitContent = {},
) {
  const dir = resolve(directory),
    recipe = join(dir, "simple-video.json");
  if (
    await access(recipe).then(
      () => true,
      () => false,
    )
  )
    throw Error(
      "Project already contains simple-video.json; choose another folder",
    );
  if (
    local &&
    (content.prompts?.length ||
      content.hero ||
      content.opponent ||
      content.setting)
  )
    throw new CliError(
      "INVALID_INPUT",
      2,
      "--local creates geometric demo artwork; omit it to use your image descriptions.",
    );
  const photos = await Promise.all(
    (content.photos ?? []).map(async (photo) => {
      const path = resolve(photo);
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new CliError(
            "PHOTO_NOT_FOUND",
            2,
            `Photo does not exist: ${path}`,
          );
        throw error;
      });
      if (!info.isFile())
        throw new CliError("INVALID_INPUT", 2, `Photo must be a file: ${path}`);
      return path;
    }),
  );
  if (
    photos.length &&
    (type === "battle" ||
      (type === "loop"
        ? photos.length !== 1
        : photos.length < 2 || photos.length > 12))
  )
    throw new CliError(
      "INVALID_INPUT",
      2,
      "--photo accepts one file for a single shot or 2–12 files for a slideshow or challenge. For a local comparison, use image.files in the recipe.",
    );
  const spec = customizeTemplate(
    type,
    photos.length
      ? {
          ...content,
          prompts: photos.map((path) => `Local photo: ${basename(path)}`),
        }
      : content,
  );
  await mkdir(dir, { recursive: true });
  if (photos.length) {
    const assets = planExperiment(spec).assets;
    const physicalDir = await realpath(dir);
    const paths = await Promise.all(
      photos.map(async (photo) => {
        const path = relative(dir, photo);
        // A shell's cwd can use the physical location of a macOS system alias.
        // Keep in-project photos relative even when the input used that alias.
        if (!isAbsolute(path) && !path.startsWith(`..${sep}`)) return path;
        const physicalPath = relative(physicalDir, await realpath(photo));
        return !isAbsolute(physicalPath) && !physicalPath.startsWith(`..${sep}`)
          ? physicalPath
          : path;
      }),
    );
    spec.image.files = Object.fromEntries(
      assets.map((asset, i) => [asset.id, paths[i]!]),
    );
  }
  if (local) {
    const assets = planExperiment(spec).assets;
    await mkdir(join(dir, "photos"), { recursive: true });
    spec.image.files = {};
    for (const [i, asset] of assets.entries()) {
      const path = `photos/${asset.id}.png`;
      const color = ["#68a4bf", "#ba8e79", "#799e88"][i % 3];
      const svg = `<svg width="540" height="960" xmlns="http://www.w3.org/2000/svg"><rect width="540" height="960" fill="${color}"/><circle cx="410" cy="170" r="80" fill="#f1dfaa"/><path d="M0 600L180 250L430 630L540 420V960H0Z" fill="#355866"/><path d="M0 780L320 420L540 800V960H0Z" fill="#244855"/><ellipse cx="210" cy="850" rx="95" ry="150" fill="#142e38"/></svg>`;
      // Original geometric demo artwork; users replace these photos with their own.
      await writeFile(
        join(dir, path),
        await sharp(Buffer.from(svg)).png().toBuffer(),
        { flag: "wx" },
      );
      spec.image.files[asset.id] = path;
    }
  }
  await writeJson(recipe, spec);
  for (const [name, content] of [
    [
      ".env.example",
      "# Optional alternative to simple-video auth login.\n# Load explicitly with --env-file; no key is needed for local photos.\nOPENAI_API_KEY=\n",
    ],
    [".gitignore", ".env\n.env.*\n!.env.example\n.simple-video/\n"],
  ]) {
    await writeFile(join(dir, name!), content!, {
      flag: "wx",
      mode: 0o600,
    }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  return {
    directory: dir,
    recipe,
    local: local || photos.length > 0,
    ...(photos.length ? { sourcePhotos: photos } : {}),
    descriptions: describeImages(spec),
    promptLocation:
      spec.type === "loop"
        ? "prompt"
        : spec.type === "battle"
          ? "hero, opponent, environment and rounds"
          : "shots[].prompt",
    next: `simple-video --project ${JSON.stringify(dir)} plan`,
  };
}
export async function exportRun(
  root: string,
  id: string,
  destination: string,
  variant?: string,
  reuseMatching = false,
) {
  const run = await readJson<Run>(
    resolve(root, "runs", safeId(id), "run.json"),
  );
  const selected = variant
    ? await readJson<{
        sourceRun: string;
        output: string;
        report: NonNullable<Run["report"]>;
        soundtrack?: Spec["soundtrack"];
      }>(resolve(root, "runs", id, "variants", safeId(variant), "render.json"))
    : run;
  if (
    !selected.output ||
    !selected.report ||
    (!variant && run.status !== "ready")
  )
    throw Error("Only a validated ready run or variant can be exported");
  if ("sourceRun" in selected && selected.sourceRun !== id)
    throw Error("Variant belongs to a different source run");
  if ((await fileHash(selected.output)) !== selected.report.sha256)
    throw Error(
      "Video changed after validation; render again before exporting",
    );
  const dir = resolve(destination);
  await mkdir(dir, { recursive: true });
  const stem = variant ? `${id}-${variant}` : id;
  const media = join(dir, `${stem}.mp4`),
    manifest = join(dir, `${stem}.json`);
  const credit =
    "soundtrack" in selected ? selected.soundtrack?.track?.credit : undefined;
  const text =
    run.plan.caption +
    (credit && !run.plan.caption.includes(credit) ? `\n\n${credit}` : "");
  const result = {
    version: 1,
    title: run.plan.name,
    text,
    video: media,
    sha256: selected.report.sha256,
    report: selected.report,
    sourceRun: id,
    ...(variant ? { variant } : {}),
    published: false,
  };
  // Accept only an identical export on a retried create. Exclusive writes
  // preserve unrelated files, including concurrent exports to this directory.
  const checkManifest = async () => {
    const existing = await readJson(manifest).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (
      existing !== undefined &&
      (!reuseMatching || stable(existing) !== stable(result))
    )
      throw new CliError(
        "EXPORT_EXISTS",
        1,
        `Export metadata already exists: ${manifest}. Choose a new directory.`,
      );
  };
  await checkManifest();
  await copyFile(selected.output, media, 1).catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      if (!reuseMatching || (await fileHash(media)) !== result.sha256)
        throw new CliError(
          "EXPORT_EXISTS",
          1,
          `Export video already exists: ${media}. Choose a new directory.`,
        );
    },
  );
  await writeFile(manifest, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    await checkManifest();
  });
  return {
    ...result,
    manifest,
    next: "Review the video, then attach the exported MP4 using simplepost post --video. This command never publishes.",
  };
}
