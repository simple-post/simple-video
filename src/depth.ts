import sharp from "sharp";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { runtimePaths } from "./runtime.js";
import { atomic, fileHash, hash, readJson, stable, writeJson } from "./io.js";

// Public, local CPU inference. Pin weights as well as the npm runtime.
export const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
export const DEPTH_REVISION = "4472b7362082ad9968fee890ca0f1e5aca36b93d";
export const DEPTH_VERSION = `${DEPTH_MODEL}@${DEPTH_REVISION}:fp32-v1`;
export type DepthEstimator = (image: Buffer) => Promise<Buffer>;
let estimator: DepthEstimator | undefined;

export async function prepareDepth(
  modelCache: string,
): Promise<DepthEstimator> {
  if (estimator) return estimator;
  const { env, pipeline, RawImage } = await import("@huggingface/transformers");
  env.cacheDir = resolve(modelCache);
  // Transformers owns native ONNX sessions; this singleton is reused across shots.
  const pipe = await pipeline("depth-estimation", DEPTH_MODEL, {
    revision: DEPTH_REVISION,
    dtype: "fp32",
    device: "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  estimator = async (image) => {
    const { data, info } = await sharp(image)
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await pipe(
      new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3),
    );
    const depth = result.depth;
    return sharp(Buffer.from(depth.data), {
      raw: { width: depth.width, height: depth.height, channels: 1 },
    })
      .png()
      .toBuffer();
  };
  return estimator;
}

export async function depthMap(
  image: Buffer,
  root: string,
  estimate?: DepthEstimator,
): Promise<Buffer> {
  const signature = hash(stable({ image: hash(image), depth: DEPTH_VERSION }));
  await mkdir(root, { recursive: true });
  const file = resolve(root, `${signature}.png`);
  const receipt = await readJson<{ sha256: string }>(`${file}.json`).catch(
    () => null,
  );
  if (receipt && (await fileHash(file).catch(() => "")) === receipt.sha256) {
    const { readFile } = await import("node:fs/promises");
    return readFile(file);
  }
  const map = await (estimate ?? (await prepareDepth(runtimePaths().models)))(
    image,
  );
  await atomic(file, map);
  await writeJson(`${file}.json`, {
    signature,
    model: DEPTH_MODEL,
    revision: DEPTH_REVISION,
    sha256: await fileHash(file),
  });
  return map;
}
