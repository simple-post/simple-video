import sharp from "sharp";
import { access, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { runtimePaths } from "./runtime.js";
import type { Scene, Spec } from "./spec.js";
import {
  atomic,
  command,
  fileHash,
  hash,
  readJson,
  stable,
  writeJson,
  cliCommand,
} from "./io.js";
import { depthMap, type DepthEstimator } from "./depth.js";
import { depthPanel } from "./parallax.js";

export const DEPTHFLOW_VERSION = "depthflow-0.9.1-edge-thicken5-linear-v1";
export function depthflowRuntime() {
  return resolve(
    process.env.SIMPLE_VIDEO_DEPTHFLOW ?? runtimePaths().depthflow,
  );
}
// DepthFlow's original DA2 preprocessing: a small Gaussian followed by a 5x5
// maximum filter. Extruding the near silhouette protects its colour boundary.
export async function thickenDepth(depth: Buffer): Promise<Buffer> {
  const meta = await sharp(depth).metadata();
  const scale = Math.min(1, 518 / Math.min(meta.width!, meta.height!));
  const { data, info } = await sharp(depth)
    .resize(Math.round(meta.width! * scale), Math.round(meta.height! * scale), {
      fit: "fill",
    })
    .greyscale()
    .blur(0.6)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length),
    w = info.width,
    h = info.height;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let near = 0;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++)
          near = Math.max(near, data[yy * w + xx]!);
      out[y * w + x] = near;
    }
  return sharp(out, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
}
export function cameraDirections(scene: Scene, index: number) {
  return {
    horizontal: (scene.panDirection ?? 1) * (index % 2 ? -1 : 1),
    vertical:
      scene.layout === "split"
        ? index % 2
          ? -1
          : 1
        : (scene.panDirection ?? 1),
  };
}
export async function renderDepthflowScene(
  scene: Scene,
  contents: Buffer[],
  spec: Spec,
  root: string,
  overlay: string,
  output: string,
  estimateDepth?: DepthEstimator,
) {
  const binary = depthflowRuntime();
  await access(binary).catch(() => {
    throw Error(
      `DepthFlow runtime is missing. Run ${cliCommand("setup")}; no CPU fallback is used.`,
    );
  });
  const workspace = runtimePaths().workspace;
  const renderEnv = {
    WORKSPACE: workspace,
    HF_HOME: runtimePaths().huggingface,
    TORCH_HOME: runtimePaths().torch,
    WINDOW_BACKEND: "headless",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
  const panels = [];
  const { width, height, fps } = spec.video,
    panelHeight = scene.layout === "split" ? height / 2 : height;
  for (const [index, image] of contents.entries()) {
    const map = await thickenDepth(
      await depthMap(image, resolve(root, "depth"), estimateDepth),
    );
    let photo = image,
      depth = map;
    if (spec.video.parallaxFit === "contain") {
      const p = await depthPanel(image, map, width, panelHeight, "contain");
      photo = await sharp(p.rgb, {
        raw: { width: p.width, height: p.height, channels: 3 },
      })
        .png()
        .toBuffer();
      depth = await sharp(p.depth, {
        raw: { width: p.width, height: p.height, channels: 1 },
      })
        .png()
        .toBuffer();
    }
    const m = await sharp(photo).metadata();
    const factor = Math.max(width / m.width!, panelHeight / m.height!);
    const rw = Math.ceil((m.width! * factor) / 2) * 2,
      rh = Math.ceil((m.height! * factor) / 2) * 2;
    const directions = cameraDirections(scene, index),
      diagonal =
        scene.layout === "split" || spec.video.parallaxPath === "diagonal";
    const intensity = spec.video.parallaxIntensity ?? 0.105;
    const signature = hash(
      stable({
        renderer: DEPTHFLOW_VERSION,
        image: hash(photo),
        depth: hash(depth),
        directions,
        diagonal,
        intensity,
        rw,
        rh,
        fps,
        duration: scene.duration,
      }),
    );
    const dir = resolve(root, "depthflow", signature),
      video = resolve(dir, "video.mp4");
    const cached = await readJson<{ sha256: string }>(
      resolve(dir, "render.json"),
    ).catch(() => null);
    if (!cached || (await fileHash(video).catch(() => "")) !== cached.sha256) {
      await mkdir(dir, { recursive: true });
      const imageFile = resolve(dir, "image.png"),
        depthFile = resolve(dir, "depth.png");
      await atomic(imageFile, photo);
      await atomic(depthFile, depth);
      const args = [
        "horizontal",
        "-i",
        String(intensity),
        directions.horizontal < 0 ? "--reverse" : "--forward",
        "--linear",
        "--no-loop",
      ];
      if (diagonal)
        args.push(
          "vertical",
          "-i",
          String(intensity),
          directions.vertical < 0 ? "--reverse" : "--forward",
          "--linear",
          "--no-loop",
        );
      args.push(
        "input",
        "-i",
        imageFile,
        "-d",
        depthFile,
        "h264",
        "--preset",
        "fast",
        "main",
        "--time",
        String(scene.duration),
        "--fps",
        String(fps),
        "-w",
        String(rw),
        "-h",
        String(rh),
        "--ratio",
        `${rw}:${rh}`,
        "--ssaa",
        "1.2",
        "--quality",
        "80",
        "--no-turbo",
        "-o",
        video,
      );
      await command(binary, args, 180000, renderEnv);
      await writeJson(resolve(dir, "render.json"), {
        signature,
        renderer: DEPTHFLOW_VERSION,
        sha256: await fileHash(video),
        intensity,
        directions,
        diagonal,
        quality: 80,
        isometric: 0.6,
        steady: 0.3,
        depthHeight: 0.2,
        paidRequests: 0,
      });
    }
    panels.push(video);
  }
  const args = [
    "-v",
    "error",
    "-y",
    ...panels.flatMap((p) => ["-i", p]),
    "-loop",
    "1",
    "-i",
    overlay,
  ];
  const filters = panels.map(
    (_, i) =>
      `[${i}:v]scale=${width}:${panelHeight}:force_original_aspect_ratio=increase,crop=${width}:${panelHeight},setsar=1[p${i}]`,
  );
  if (panels.length === 2) filters.push("[p0][p1]vstack=inputs=2[base]");
  else filters.push("[p0]null[base]");
  let base = "base";
  if (scene.zoomIntro) {
    const z = scene.zoomIntro;
    filters.push(
      `[base]zoompan=z='1+${z.factor - 1}*max(0,1-on/${fps * z.duration})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${fps}[intro]`,
    );
    base = "intro";
  }
  filters.push(
    `[${base}][${panels.length}:v]overlay=0:0:shortest=1,format=yuv420p[v]`,
  );
  const temp = output + ".tmp.mp4";
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-an",
    "-frames:v",
    String(Math.round(scene.duration * fps)),
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-threads",
    "2",
    "-movflags",
    "+faststart",
    temp,
  );
  await command("ffmpeg", args);
  await rename(temp, output);
}
