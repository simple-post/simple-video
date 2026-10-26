import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { SpecSchema, type Spec } from "./spec.js";
import type { Run } from "./runner.js";
import {
  fileHash,
  hash,
  readJson,
  safeId,
  stable,
  withLock,
  writeJson,
} from "./io.js";
import {
  assemble,
  contactSheet,
  RENDER_VERSION,
  renderScene,
  validateMedia,
} from "./render.js";
import { DEPTH_VERSION, type DepthEstimator } from "./depth.js";
import {
  AUDIO_RENDER_VERSION,
  soundtrackAssets,
  type Soundtrack,
} from "./soundtrack.js";

// Rendering never loads credentials or imports an image provider. It preserves
// the generation experiment and saves independently reproducible variants.
export async function rerender(
  id: string,
  videoOptions: Partial<Spec["video"]>,
  options: {
    root: string;
    log?: (event: unknown) => void;
    estimateDepth?: DepthEstimator;
    soundtrack?: Soundtrack;
  },
) {
  const root = resolve(options.root);
  const runDir = resolve(root, "runs", safeId(id));
  return withLock(root, async () => {
    const run = await readJson<Run>(resolve(runDir, "run.json"));
    const spec = SpecSchema.parse({
      ...run.spec,
      ...(options.soundtrack ? { soundtrack: options.soundtrack } : {}),
      video: { ...run.spec.video, ...videoOptions },
    });
    const files: Record<string, string> = {};
    for (const asset of run.plan.assets) {
      const state = run.assets[asset.id];
      if (
        !state?.file ||
        state.status !== "ready" ||
        !state.sha256 ||
        (await fileHash(state.file).catch(() => "")) !== state.sha256
      )
        throw new Error(
          `Cached image ${asset.id} changed or disappeared; render requires verified generated assets`,
        );
      files[asset.id] = state.file;
    }
    const scenes = run.plan.scenes.map((scene, i) => ({
      ...scene,
      ...(spec.video.alternateDirections && scene.panDirection === undefined
        ? { panDirection: (i % 2 ? -1 : 1) as 1 | -1 }
        : {}),
    }));
    const signature = hash(
      stable({
        renderer: RENDER_VERSION,
        audioRenderer: AUDIO_RENDER_VERSION,
        depth: spec.video.motion === "parallax" ? DEPTH_VERSION : undefined,
        video: spec.video,
        soundtrack: spec.soundtrack,
        audioLufs: spec.audioLufs,
        recordedAssets: await soundtrackAssets(spec.soundtrack),
        scenes,
        assets: run.plan.assets.map((a) => run.assets[a.id]!.sha256),
      }),
    );
    const variantDir = resolve(
      runDir,
      "variants",
      `${spec.video.motion}-${signature.slice(0, 12)}`,
    );
    await mkdir(variantDir, { recursive: true });
    const clips = [];
    for (const scene of scenes) {
      options.log?.({
        stage: "render",
        scene: scene.id,
        motion: spec.video.motion,
      });
      clips.push(
        await renderScene(
          scene,
          files,
          spec,
          resolve(root, "renders", RENDER_VERSION),
          options.estimateDepth,
        ),
      );
    }
    const output = await assemble(clips, run.plan.duration, spec, variantDir);
    const report = await validateMedia(output, spec, run.plan.duration);
    await contactSheet(output, run.plan.duration, variantDir);
    const result = {
      sourceRun: id,
      variant: `${spec.video.motion}-${signature.slice(0, 12)}`,
      signature,
      renderer: RENDER_VERSION,
      video: spec.video,
      soundtrack: spec.soundtrack,
      audioLufs: spec.audioLufs,
      output,
      report,
      paidRequests: 0,
    };
    await writeJson(resolve(variantDir, "render.json"), result);
    await writeJson(resolve(variantDir, "simplepost-preparation.json"), {
      postingMode: "draft",
      message: `${run.plan.caption}${spec.soundtrack?.track && !run.plan.caption.includes(spec.soundtrack.track.credit) ? `\n\n${spec.soundtrack.track.credit}` : ""}`,
      mediaFile: output,
      mediaSha256: report.sha256,
      accountIds: [],
      note: "Local preparation only; no upload or post.",
    });
    return result;
  });
}
