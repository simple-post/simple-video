import { spawn } from "node:child_process";
import sharp from "sharp";
import type { Spec } from "./spec.js";

export type DepthPanel = {
  width: number;
  height: number;
  rgb: Buffer;
  depth: Buffer;
};

export async function depthPanel(
  image: Buffer,
  depth: Buffer,
  width: number,
  height: number,
  fit: "cover" | "contain" = "cover",
): Promise<DepthPanel> {
  if (fit === "contain") {
    // Keep the complete photograph inside the maximum camera overscan/pan.
    const inside = await sharp(image)
      .resize(Math.round(width * 0.72), Math.round(height * 0.72), {
        fit: "inside",
      })
      .removeAlpha()
      .toColourspace("srgb")
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = Math.floor((width - inside.info.width) / 2),
      top = Math.floor((height - inside.info.height) / 2);
    const map = await sharp(depth)
      .resize(inside.info.width, inside.info.height, { fit: "fill" })
      .greyscale()
      .blur(0.6)
      .png()
      .toBuffer();
    const [rgb, paddedDepth] = await Promise.all([
      sharp(image)
        .resize(width, height, { fit: "cover" })
        .blur(40)
        .composite([{ input: inside.data, left, top }])
        .removeAlpha()
        .toColourspace("srgb")
        .raw()
        .toBuffer(),
      sharp({ create: { width, height, channels: 3, background: "black" } })
        .composite([{ input: map, left, top }])
        .greyscale()
        .raw()
        .toBuffer(),
    ]);
    return { width, height, rgb, depth: paddedDepth };
  }
  const [rgb, map] = await Promise.all([
    sharp(image)
      .resize(width, height, { fit: "cover" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(depth)
      .resize(width, height, { fit: "cover" })
      .greyscale()
      .blur(0.6)
      .raw()
      .toBuffer(),
  ]);
  return { width, height, rgb, depth: map };
}

// Cast a ray through the estimated relief surface. Near intersections occlude
// far ones; bilinear RGB sampling keeps subpixel camera movement smooth.
// Overscan covers the image border. Newly exposed surfaces use the single
// photograph's texture, so extreme movements can stretch silhouette edges.
export function parallaxFrame(
  panel: DepthPanel,
  progress: number,
  strength: number,
  direction = 1,
  path: "pan" | "diagonal" | "orbit" = "pan",
  introScale = 1,
): Buffer {
  const { width: w, height: h, rgb, depth } = panel;
  const out = Buffer.allocUnsafe(w * h * 3);
  const t = progress * progress * (3 - 2 * progress);
  const phase = progress === 1 ? 0 : progress;
  const dx =
    (path === "orbit" ? Math.sin(2 * Math.PI * phase) : 2 * t - 1) *
    w *
    strength *
    direction;
  const dy =
    (path === "orbit"
      ? 1 - Math.cos(2 * Math.PI * phase)
      : path === "diagonal"
        ? (2 * t - 1) * direction
        : 0) *
    h *
    strength *
    0.14;
  const zoom =
    1 +
    2.5 * strength +
    (path === "orbit" ? 0.02 * Math.sin(Math.PI * phase) ** 2 : 0.025 * t);
  const inv = 1 / (zoom * introScale);
  const cx = (w - 1) / 2,
    cy = (h - 1) / 2;
  const depthAt = (x: number, y: number) =>
    depth[
      Math.max(0, Math.min(h - 1, Math.round(y))) * w +
        Math.max(0, Math.min(w - 1, Math.round(x)))
    ]! / 255;
  for (let y = 0; y < h; y++) {
    const by = (y - cy) * inv + cy;
    for (let x = 0; x < w; x++) {
      const bx = (x - cx) * inv + cx;
      let near = 1,
        far = 0;
      // Front-to-back search, then refine the first surface intersection.
      for (let step = 0; step <= 8; step++) {
        const z = 1 - step / 8;
        const scale = 0.15 + 0.85 * z;
        if (depthAt(bx - dx * scale, by - dy * scale) >= z) {
          far = z;
          break;
        }
        near = z;
      }
      for (let step = 0; step < 4; step++) {
        const z = (near + far) / 2;
        const scale = 0.15 + 0.85 * z;
        if (depthAt(bx - dx * scale, by - dy * scale) >= z) far = z;
        else near = z;
      }
      const scale = 0.15 + (0.85 * (near + far)) / 2;
      const sx = Math.max(0, Math.min(w - 1.001, bx - dx * scale));
      const sy = Math.max(0, Math.min(h - 1.001, by - dy * scale));
      const xx = Math.floor(sx),
        yy = Math.floor(sy),
        fx = sx - xx,
        fy = sy - yy;
      const a = (yy * w + xx) * 3,
        b = a + 3,
        c = a + w * 3,
        d = c + 3;
      const i = (y * w + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        out[i + channel] =
          (rgb[a + channel]! * (1 - fx) + rgb[b + channel]! * fx) * (1 - fy) +
          (rgb[c + channel]! * (1 - fx) + rgb[d + channel]! * fx) * fy;
    }
  }
  return out;
}

export async function encodeParallax(
  panels: DepthPanel[],
  video: Spec["video"],
  frames: number,
  textFile: string,
  output: string,
  options: {
    direction?: 1 | -1;
    zoomIntro?: { duration: number; factor: number };
  } = {},
): Promise<void> {
  const { width, height, fps } = video;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-loop",
    "1",
    "-i",
    textFile,
    "-filter_complex",
    "[0:v][1:v]overlay=0:0:shortest=1,format=yuv420p[v]",
    "-map",
    "[v]",
    "-an",
    "-frames:v",
    String(frames),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-threads",
    "2",
    "-movflags",
    "+faststart",
    output,
  ];
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (b) => {
    stderr = (stderr + String(b)).slice(-8000);
  });
  // Attach handlers immediately, including EPIPE if FFmpeg rejects the input.
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Parallax FFmpeg exited ${code}: ${stderr}`)),
    );
  });
  void done.catch(() => {});
  let writeError: Error | undefined;
  child.stdin.on("error", (e) => {
    writeError = e;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20 * 60 * 1000);
  try {
    for (let frame = 0; frame < frames; frame++) {
      const intro = options.zoomIntro;
      const introScale = intro
        ? 1 + (intro.factor - 1) * Math.max(0, 1 - frame / fps / intro.duration)
        : 1;
      const buffers = panels.map((p, i) =>
        parallaxFrame(
          p,
          frame / Math.max(1, frames - 1),
          video.parallaxStrength ?? 0.045,
          (options.direction ?? 1) * (i % 2 ? -1 : 1),
          video.parallaxPath ?? "pan",
          introScale,
        ),
      );
      if (writeError) throw writeError;
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(Buffer.concat(buffers), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
    child.stdin.end();
    await done;
  } catch (e) {
    child.kill("SIGKILL");
    await done.catch(() => {});
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
