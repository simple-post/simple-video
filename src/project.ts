import { dirname, resolve, join } from "node:path";
import { mkdir, copyFile, writeFile, access } from "node:fs/promises";
import sharp from "sharp";
import { SpecSchema, planExperiment, template, type Spec } from "./spec.js";
import { readJson, writeJson, safeId, fileHash } from "./io.js";
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
export async function initProject(
  directory: string,
  type: Spec["type"],
  local = false,
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
  await mkdir(dir, { recursive: true });
  const spec = template(type);
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
      "# Supply your own key; no key is required for local photos.\nOPENAI_API_KEY=\n",
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
    local,
    next: `simple-video --project ${JSON.stringify(dir)} plan`,
  };
}
export async function exportRun(
  root: string,
  id: string,
  destination: string,
  variant?: string,
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
  await copyFile(selected.output, media, 1); // COPYFILE_EXCL: never overwrite user files.
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
    variant,
    published: false,
  };
  await writeJson(manifest, result);
  return {
    ...result,
    manifest,
    next: "Review the video, then attach the exported MP4 using simplepost post --video. This command never publishes.",
  };
}
