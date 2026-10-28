import { resolve } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { SpecSchema, planExperiment, type Spec, type Plan } from "./spec.js";
import {
  atomic,
  fileHash,
  hash,
  readJson,
  safeError,
  safeId,
  stable,
  withLock,
  writeJson,
} from "./io.js";
import {
  decodeResponse,
  ProviderError,
  type ImageProvider,
} from "./provider.js";
import {
  assemble,
  contactSheet,
  RENDER_VERSION,
  renderScene,
  validateMedia,
  type MediaReport,
} from "./render.js";

type Attempt = {
  at: string;
  status: "requesting" | "ready" | "rejected" | "uncertain";
  estimatedUsd: number;
  paid: boolean;
  requestId?: string;
  usage?: unknown;
  error?: string;
};
type AssetState = {
  key: string;
  status: "pending" | "requesting" | "ready" | "rejected" | "uncertain";
  file?: string;
  sha256?: string;
  attempts: Attempt[];
};
export type Run = {
  version: 1;
  id: string;
  signature: string;
  spec: Spec;
  plan: Plan;
  provider: string;
  providerIdentity: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  assets: Record<string, AssetState>;
  scenes: Record<string, string>;
  output?: string;
  report?: MediaReport;
  error?: string;
};
export type RunnerOptions = {
  root: string;
  id?: string;
  retryUncertain?: boolean;
  imagesOnly?: boolean;
  log?: (event: unknown) => void;
};
async function optionalJson<T>(file: string) {
  return readJson<T>(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
}
export function requestTotals(run: Run) {
  const attempts = Object.values(run.assets)
    .flatMap((a) => a.attempts)
    .filter((a) => a.paid);
  const ready = attempts.filter((a) => a.status === "ready");
  const usageCosts = ready.map((a) =>
    imageUsageEstimate(run.spec.image.model, a.usage),
  );
  return {
    requests: attempts.length,
    estimatedUsd: attempts
      .filter((a) => a.status !== "rejected")
      .reduce((n, a) => n + a.estimatedUsd, 0),
    successfulRequests: ready.length,
    uncertainRequests: attempts.filter(
      (a) => a.status === "uncertain" || a.status === "requesting",
    ).length,
    ...(ready.length && usageCosts.every((c) => c !== null)
      ? {
          usageEstimatedUsd: Number(
            usageCosts.reduce<number>((n, c) => n + c!, 0).toFixed(6),
          ),
          pricingAsOf: "2026-10-10",
        }
      : {}),
  };
}
export function imageUsageEstimate(
  model: string,
  usage: unknown,
): number | null {
  // Standard pricing verified at https://developers.openai.com/api/docs/models/gpt-image-2.5-flare.
  // Preserve raw usage; this estimate is not an invoice. Unrecognized models return unknown.
  if (
    !/^gpt-image-2\.5-flare(?:-2026-09-08)?$/.test(model) ||
    !usage ||
    typeof usage !== "object"
  )
    return null;
  const u = usage as {
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
    output_tokens?: number;
  };
  const text = u.input_tokens_details?.text_tokens;
  const image = u.input_tokens_details?.image_tokens;
  const output = u.output_tokens;
  if (
    ![text, image, output].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  )
    return null;
  return (text! * 5 + image! * 8 + output! * 30) / 1_000_000;
}
export function checkBudget(run: Run) {
  const totals = requestTotals(run);
  const b = run.spec.budget;
  if (totals.requests >= b.maxRequests)
    throw new Error(
      `Request cap reached (${b.maxRequests}); no paid request sent`,
    );
  if (totals.estimatedUsd + b.estimatePerImageUsd > b.maxEstimatedUsd + 1e-9)
    throw new Error("Estimated budget cap reached; no paid request sent");
}
export async function runExperiment(
  input: unknown,
  provider: ImageProvider,
  options: RunnerOptions,
): Promise<Run> {
  const spec = SpecSchema.parse(input);
  const plan = planExperiment(spec);
  const signature = hash(
    stable({ spec, provider: provider.identity, storyboard: 1 }),
  );
  const id = safeId(options.id ?? `${spec.type}-${signature.slice(0, 12)}`);
  const root = resolve(options.root);
  const runDir = resolve(root, "runs", id);
  const runFile = resolve(runDir, "run.json");
  return withLock(root, async () => {
    await mkdir(runDir, { recursive: true });
    let run = await readJson<Run>(runFile).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (run && run.signature !== signature)
      throw new Error(
        "Run ID already belongs to different settings. Use a new ID for a new experiment",
      );
    if (!run)
      run = {
        version: 1,
        id,
        signature,
        spec,
        plan,
        provider: provider.name,
        providerIdentity: provider.identity,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "planned",
        assets: {},
        scenes: {},
      };
    const current = run;
    const save = async () => {
      current.updatedAt = new Date().toISOString();
      await writeJson(runFile, current);
    };
    const log = (event: unknown) => options.log?.(event);
    try {
      await writeJson(resolve(runDir, "storyboard.json"), plan);
      await save();
      // Complete preflight before paying for any assets.
      const { command } = await import("./io.js");
      if (!options.imagesOnly) {
        await command("ffmpeg", ["-version"]);
        await command("ffprobe", ["-version"]);
      }
      if (
        !options.imagesOnly &&
        spec.video.motion === "parallax" &&
        spec.video.parallaxEngine === "depthflow"
      ) {
        const { probeGraphics } = await import("./runtime.js");
        log({ stage: "preflight", step: "graphics" });
        await probeGraphics();
      }
      if (
        provider.paid &&
        !process.env.OPENAI_API_KEY &&
        provider.name === "openai"
      )
        throw new Error("OPENAI_API_KEY is missing");
      const required = plan.assets.length;
      if (provider.paid && required > spec.budget.maxRequests)
        throw new Error(
          `Plan requires ${required} images but maxRequests is ${spec.budget.maxRequests}`,
        );
      if (
        !options.imagesOnly &&
        spec.video.motion === "parallax" &&
        provider.name === "openai"
      ) {
        log({ stage: "depth", status: "preflight" });
        const { prepareDepth } = await import("./depth.js");
        await prepareDepth(
          (await import("./runtime.js")).runtimePaths().models,
        );
      }
      current.status = "generating";
      delete current.error;
      await save();
      for (const asset of plan.assets) {
        const previous = asset.referenceAsset
          ? current.assets[asset.referenceAsset]
          : undefined;
        if (
          asset.referenceAsset &&
          (!previous?.file || previous.status !== "ready")
        )
          throw new Error(
            `Reference image ${asset.referenceAsset} is not ready`,
          );
        const reference = previous?.file
          ? await readFile(previous.file)
          : undefined;
        if (reference && hash(reference) !== previous!.sha256)
          throw new Error(`Reference image ${asset.referenceAsset} changed`);
        const key = hash(
          stable({
            provider: provider.identity,
            model: spec.image,
            asset,
            imagePipeline: 1,
            ...(reference ? { referenceSha256: hash(reference) } : {}),
          }),
        );
        const dir = resolve(root, "assets", key);
        const file = resolve(dir, "image.png");
        const receipt = resolve(dir, "asset.json");
        const responseFile = resolve(dir, "response.json");
        const requestFile = resolve(dir, "request-state.json");
        const state = current.assets[asset.id] ?? {
          key,
          status: "pending" as const,
          attempts: [],
        };
        current.assets[asset.id] = state;
        if (state.status === "ready") {
          if (state.sha256 !== (await fileHash(file).catch(() => "")))
            throw new Error(
              `Cached image ${asset.id} changed or disappeared; restore it before resuming`,
            );
          log({ stage: "image", asset: asset.id, status: "reused" });
          continue;
        }
        const cached = await optionalJson<{ sha256: string }>(receipt);
        if (cached && cached.sha256 !== (await fileHash(file).catch(() => "")))
          throw new Error(
            `Cached image ${asset.id} changed or disappeared; restore it before resuming`,
          );
        if (
          cached &&
          cached.sha256 === (await fileHash(file).catch(() => ""))
        ) {
          const last = state.attempts.at(-1);
          if (last?.status === "requesting" || last?.status === "uncertain")
            last.status = "ready";
          state.status = "ready";
          state.file = file;
          state.sha256 = cached.sha256;
          await save();
          log({ stage: "image", asset: asset.id, status: "cache-hit" });
          continue;
        }
        let generated;
        // Recover a response saved before an image decode or process interruption.
        const savedBody = await readFile(responseFile, "utf8").catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
          },
        );
        if (savedBody)
          generated = decodeResponse(
            savedBody,
            state.attempts.at(-1)?.requestId,
          );
        else {
          const sharedRequest = await optionalJson<{
            status: string;
            runId: string;
          }>(requestFile);
          if (
            sharedRequest &&
            ["requesting", "uncertain"].includes(sharedRequest.status) &&
            sharedRequest.runId !== id &&
            !options.retryUncertain
          )
            throw new Error(
              `Asset ${asset.id} has an uncertain paid request in run ${sharedRequest.runId}. Inspect it before using --retry-uncertain`,
            );
          if (state.status === "requesting" || state.status === "uncertain") {
            state.status = "uncertain";
            const last = state.attempts.at(-1);
            if (last) last.status = "uncertain";
            await save();
            if (!options.retryUncertain)
              throw new Error(
                `Asset ${asset.id} has an uncertain paid request. Inspect the provider; only use --retry-uncertain if you accept another charge`,
              );
          }
          if (provider.paid) checkBudget(current);
          const attempt: Attempt = {
            at: new Date().toISOString(),
            status: "requesting",
            estimatedUsd: provider.paid ? spec.budget.estimatePerImageUsd : 0,
            paid: provider.paid,
          };
          state.status = "requesting";
          state.attempts.push(attempt);
          await save();
          await writeJson(requestFile, {
            status: "requesting",
            runId: id,
            at: attempt.at,
          });
          log({
            stage: "image",
            asset: asset.id,
            status: "requesting",
            ...requestTotals(current),
          });
          try {
            generated = await provider.generate(
              asset,
              spec,
              async (body) => atomic(responseFile, body),
              reference,
            );
            attempt.requestId = generated.requestId;
            attempt.usage = generated.usage;
          } catch (e) {
            const uncertain = !(e instanceof ProviderError) || e.uncertain;
            state.status = uncertain ? "uncertain" : "rejected";
            attempt.status = state.status;
            attempt.error = safeError(e);
            if (e instanceof ProviderError) attempt.requestId = e.requestId;
            await writeJson(requestFile, {
              status: state.status,
              runId: id,
              requestId: attempt.requestId,
            });
            await save();
            throw e;
          }
        }
        await sharp(generated.bytes)
          .metadata()
          .then((m) => {
            if (!m.width || !m.height)
              throw new Error("Generated image could not be decoded");
          });
        await atomic(file, generated.bytes);
        const sha256 = await fileHash(file);
        const last = state.attempts.at(-1);
        if (last) {
          last.status = "ready";
          last.usage = generated.usage;
          last.requestId ??= generated.requestId;
        }
        await writeJson(receipt, {
          key,
          sha256,
          provider: provider.identity,
          model: spec.image.model,
          requestId: generated.requestId,
          usage: generated.usage,
        });
        await writeJson(requestFile, {
          status: "ready",
          runId: id,
          requestId: generated.requestId,
        });
        state.status = "ready";
        state.file = file;
        state.sha256 = sha256;
        await save();
        log({ stage: "image", asset: asset.id, status: "ready" });
      }
      if (options.imagesOnly) {
        current.status = "images-ready";
        await save();
        return current;
      }
      current.status = "rendering";
      await save();
      const assetFiles = Object.fromEntries(
        Object.entries(current.assets).map(([id, a]) => [id, a.file!]),
      );
      const clips: string[] = [];
      for (const scene of plan.scenes) {
        log({ stage: "render", scene: scene.id });
        const clip = await renderScene(
          scene,
          assetFiles,
          spec,
          resolve(root, "renders", RENDER_VERSION),
        );
        current.scenes[scene.id] = clip;
        clips.push(clip);
        await save();
      }
      log({ stage: "assemble" });
      current.output = await assemble(clips, plan.duration, spec, runDir);
      current.status = "validating";
      await save();
      log({ stage: "validate" });
      current.report = await validateMedia(current.output, spec, plan.duration);
      await contactSheet(current.output, plan.duration, runDir);
      await writeJson(resolve(runDir, "simplepost-preparation.json"), {
        postingMode: "draft",
        message: plan.caption,
        mediaFile: current.output,
        mediaSha256: current.report.sha256,
        accountIds: [],
        note: "Local preparation only. Add account IDs and use publish draft explicitly after configuring SimplePost.",
      });
      current.status = "ready";
      await save();
      log({
        stage: "complete",
        id,
        output: current.output,
        ...requestTotals(current),
        report: current.report,
      });
      return current;
    } catch (e) {
      current.status = "failed";
      current.error = safeError(e);
      await save();
      throw e;
    }
  });
}
