import sharp from "sharp";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import type { Scene, Spec } from "./spec.js";
import { applySoundtrack, masterAudio } from "./soundtrack.js";
import { depthMap, DEPTH_VERSION, type DepthEstimator } from "./depth.js";
import { renderDepthflowScene, DEPTHFLOW_VERSION } from "./depthflow.js";
import { depthPanel, encodeParallax } from "./parallax.js";
import {
  atomic,
  command,
  fileHash,
  hash,
  readJson,
  stable,
  writeJson,
} from "./io.js";

export const RENDER_VERSION = "depth-parallax-v4-depthflow";
export type MediaReport = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec?: string;
  frames: number;
  bytes: number;
  sha256: string;
  checks: string[];
};
const escape = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
function wrap(text: string, max: number): string[] {
  const lines = [""];
  for (const word of text.split(/\s+/)) {
    const i = lines.length - 1;
    if (lines[i]!.length + word.length + 1 > max && lines[i]) lines.push(word);
    else lines[i] = `${lines[i]} ${word}`.trim();
  }
  return lines;
}
export async function captionOverlay(
  scene: Scene,
  width: number,
  height: number,
): Promise<Buffer> {
  const unit = width / 1080;
  if (scene.captionStyle === "classic-count" || !scene.caption) {
    const label = scene.caption
      ? `<text x="${width / 2}" y="${height / 2 + 23 * unit}" text-anchor="middle" font-family="Oswald, Arial, sans-serif" font-size="${78 * unit}" font-weight="bold" fill="white" stroke="#151515" stroke-width="${4 * unit}" paint-order="stroke">${escape(scene.caption)}</text>`
      : "";
    return sharp(
      Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${label}</svg>`,
      ),
    )
      .png()
      .toBuffer();
  }
  if (scene.captionStyle === "confession") {
    const lines = wrap(scene.caption, 28);
    const svg = `<svg width="${width}" height="${height}">${lines.map((line, i) => `<text x="${width / 2}" y="${(150 + i * 76) * unit}" text-anchor="middle" font-family="Arial, Liberation Sans, sans-serif" font-size="${64 * unit}" font-weight="bold" fill="white" stroke="#111" stroke-width="${5 * unit}" stroke-linejoin="round" paint-order="stroke">${escape(line)}</text>`).join("")}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
  const split = scene.layout === "split";
  const lines = wrap(scene.caption, 28);
  const y =
    scene.captionPosition === "top"
      ? 310 * unit
      : split
        ? height / 2 + 22 * unit
        : height - 330 * unit;
  const text = (
    value: string,
    yy: number,
    size: number,
    anchor = "middle",
    x = width / 2,
  ) =>
    `<text x="${x}" y="${yy}" text-anchor="${anchor}" font-family="Arial, Liberation Sans, sans-serif" font-size="${size * unit}" font-weight="bold" fill="white" stroke="#101010" stroke-width="${5 * unit}" paint-order="stroke">${escape(value)}</text>`;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${y - 82 * unit}" width="${width}" height="${(lines.length * 82 + 25) * unit}" fill="#000" opacity="0.32"/>${lines.map((line, i) => text(line, y + i * 82 * unit, split ? 84 : 65)).join("")}${split && scene.labels ? scene.labels.map((label, i) => text(label, (i * height) / 2 + 95 * unit, 38)).join("") : ""}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
export async function renderScene(
  scene: Scene,
  assetFiles: Record<string, string>,
  spec: Spec,
  root: string,
  estimateDepth?: DepthEstimator,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const contents = await Promise.all(
    scene.assets.map(async (id) => {
      const file = assetFiles[id];
      if (!file)
        throw new Error(`Scene ${scene.id} references missing asset ${id}`);
      return readFile(file);
    }),
  );
  const motionVideo = {
    ...spec.video,
    parallaxPath:
      spec.video.parallaxPath ??
      (spec.type === "loop" ? ("orbit" as const) : ("pan" as const)),
  };
  const signature = hash(
    stable({
      renderer: RENDER_VERSION,
      scene,
      video: motionVideo,
      orbit:
        motionVideo.parallaxPath === "orbit" ? "closed-orbit-v1" : undefined,
      depth: spec.video.motion === "parallax" ? DEPTH_VERSION : undefined,
      engine:
        spec.video.parallaxEngine === "depthflow"
          ? DEPTHFLOW_VERSION
          : "cpu-v3",
      assets: contents.map(hash),
    }),
  );
  const output = resolve(root, `${signature}.mp4`);
  const receipt = `${output}.json`;
  const cached = await readJson<{ sha256: string }>(receipt).catch(() => null);
  if (cached && (await fileHash(output).catch(() => "")) === cached.sha256)
    return output;
  const { width, height, fps } = spec.video;
  const frames = Math.round(scene.duration * fps);
  if (Math.abs(frames / fps - scene.duration) > 0.00001)
    throw new Error("Scene duration must be an exact number of output frames");
  const textFile = resolve(root, `${signature}-overlay.png`);
  await atomic(textFile, await captionOverlay(scene, width, height));
  if (
    spec.video.motion === "parallax" &&
    spec.video.parallaxEngine === "depthflow"
  ) {
    await renderDepthflowScene(
      scene,
      contents,
      spec,
      root,
      textFile,
      output,
      estimateDepth,
    );
    await writeJson(receipt, {
      signature,
      renderer: RENDER_VERSION,
      engine: DEPTHFLOW_VERSION,
      depth: DEPTH_VERSION,
      sha256: await fileHash(output),
    });
    return output;
  }
  if (spec.video.motion === "parallax") {
    const panels = [];
    for (const content of contents) {
      const depth = await depthMap(
        content,
        resolve(root, "depth"),
        estimateDepth,
      );
      panels.push(
        await depthPanel(
          content,
          depth,
          width,
          scene.layout === "split" ? height / 2 : height,
          spec.video.parallaxFit,
        ),
      );
    }
    const temporary = `${output}.tmp.mp4`;
    await encodeParallax(panels, motionVideo, frames, textFile, temporary, {
      direction: scene.panDirection,
      zoomIntro: scene.zoomIntro,
    });
    const { rename } = await import("node:fs/promises");
    await rename(temporary, output);
    await writeJson(receipt, {
      signature,
      renderer: RENDER_VERSION,
      depth: DEPTH_VERSION,
      sha256: await fileHash(output),
    });
    return output;
  }
  let base: Buffer;
  if (scene.layout === "split") {
    const halves = await Promise.all(
      contents.map((b) =>
        sharp(b)
          .resize(width, height / 2, { fit: "cover" })
          .png()
          .toBuffer(),
      ),
    );
    base = await sharp({
      create: { width, height, channels: 3, background: "#101010" },
    })
      .composite(
        halves.map((input, i) => ({ input, top: (i * height) / 2, left: 0 })),
      )
      .png()
      .toBuffer();
  } else
    base = await sharp(contents[0]!)
      .resize(width, height, { fit: "cover" })
      .png()
      .toBuffer();
  const baseFile = resolve(root, `${signature}-base.png`);
  await atomic(baseFile, base);
  const zoom =
    spec.video.motion === "zoom"
      ? `1+0.055*on/${Math.max(1, frames - 1)}`
      : "1";
  const filter = `[0:v]scale=${width * 2}:${height * 2},zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=${width}x${height}:fps=${fps},setsar=1[bg];[bg][1:v]overlay=0:0:shortest=1,format=yuv420p[v]`;
  const temporary = `${output}.tmp.mp4`;
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    baseFile,
    "-loop",
    "1",
    "-i",
    textFile,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-an",
    "-frames:v",
    String(frames),
    "-r",
    String(fps),
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
    temporary,
  ]);
  const { rename } = await import("node:fs/promises");
  await rename(temporary, output);
  await writeJson(receipt, { signature, sha256: await fileHash(output) });
  return output;
}
export async function assemble(
  files: string[],
  duration: number,
  spec: Spec,
  runDir: string,
) {
  if (!files.length) throw new Error("No scenes to assemble");
  const list = resolve(runDir, "concat.txt");
  // These paths are generated hash names, never user-provided ffconcat syntax.
  if (files.some((f) => /['\r\n]/.test(f)))
    throw new Error(
      "Render cache path contains unsupported ffconcat characters",
    );
  await atomic(list, files.map((f) => `file '${f}'`).join("\n"));
  const temp = resolve(runDir, "video.tmp.mp4");
  const out = resolve(runDir, "video.mp4");
  const audio =
    spec.video.audio === "synth"
      ? `aevalsrc='0.07*sin(2*PI*55*t)*(0.35+0.65*exp(-18*mod(t,0.5)))+0.025*sin(2*PI*110*t)':s=48000:d=${duration}`
      : spec.video.audio === "tension"
        ? `aevalsrc='0.11*sin(2*PI*(48+8*t/${duration})*t)*exp(-24*mod(t,0.4))+0.035*sin(2*PI*(180*t+25*t*t))*min(1,t/${duration})':s=48000:d=${duration}`
        : spec.video.audio === "ambient"
          ? `anoisesrc=color=pink:amplitude=0.055:sample_rate=48000:seed=2026:duration=${duration},highpass=f=150,lowpass=f=4500`
          : `anullsrc=r=48000:cl=stereo`;
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-f",
    "lavfi",
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ac",
    "2",
    "-t",
    String(duration),
    "-movflags",
    "+faststart",
    temp,
  ]);
  const { rename } = await import("node:fs/promises");
  await rename(temp, out);
  await applySoundtrack(out, duration, spec.soundtrack);
  return masterAudio(out, spec.audioLufs);
}
export async function validateMedia(
  file: string,
  spec: Spec,
  expectedDuration: number,
): Promise<MediaReport> {
  const data = JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      file,
    ]),
  ) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width: number;
      height: number;
      avg_frame_rate: string;
      nb_frames: string;
    }[];
    format: { duration: string; size: string };
  };
  const v = data.streams.find((s) => s.codec_type === "video");
  const a = data.streams.find((s) => s.codec_type === "audio");
  if (!v || !a)
    throw new Error("Output must have both video and audio streams");
  const [n, d] = v.avg_frame_rate.split("/").map(Number);
  const fps = n! / d!;
  const duration = Number(data.format.duration);
  if (
    v.width !== spec.video.width ||
    v.height !== spec.video.height ||
    Math.abs(fps - spec.video.fps) > 0.01 ||
    Math.abs(duration - expectedDuration) > 1 / spec.video.fps + 0.01 ||
    v.codec_name !== "h264" ||
    a.codec_name !== "aac"
  )
    throw new Error(
      "Output dimensions, timing or codecs do not match the experiment",
    );
  // Decode the full video and audio, so corrupt/truncated files cannot pass metadata checks.
  await command("ffmpeg", [
    "-v",
    "error",
    "-xerror",
    "-i",
    file,
    "-f",
    "null",
    "-",
  ]);
  return {
    duration,
    width: v.width,
    height: v.height,
    fps,
    codec: v.codec_name,
    audioCodec: a.codec_name,
    frames: Number(v.nb_frames),
    bytes: Number(data.format.size),
    sha256: await fileHash(file),
    checks: ["dimensions", "frame-rate", "duration", "h264-aac", "full-decode"],
  };
}
export async function contactSheet(
  file: string,
  duration: number,
  runDir: string,
) {
  const out = resolve(runDir, "contact-sheet.jpg");
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    `fps=6/${duration},scale=270:480,tile=6x1`,
    "-frames:v",
    "1",
    out,
  ]);
  return out;
}
