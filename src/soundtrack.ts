import { z } from "zod";
import { resolve, dirname } from "node:path";
import { rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomic, command, fileHash } from "./io.js";

const recordedCue = z
  .object({
    file: z.string().min(1),
    at: z.number().nonnegative().max(180),
    start: z.number().nonnegative().default(0),
    duration: z.number().positive().max(180),
    gainDb: z.number().min(-60).max(12).default(-8),
  })
  .strict();

// Procedural scores remain available; recorded scores use licensed local files.
export const SoundtrackSchema = z
  .object({
    music: z.enum(["playful", "suspense", "none", "recorded"]),
    track: z
      .object({
        file: z.string().min(1),
        start: z.number().nonnegative(),
        gainDb: z.number().min(-60).max(12),
        credit: z.string().min(1),
        source: z.url(),
        license: z.url(),
      })
      .strict()
      .optional(),
    recordedCues: z.array(recordedCue).max(32).optional(),
    ducks: z
      .array(
        z
          .object({
            at: z.number().nonnegative().max(180),
            duration: z.number().positive().max(180),
            gainDb: z.number().min(-60).max(0),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    musicUntil: z.number().positive().max(180).optional(),
    cues: z
      .array(
        z
          .object({
            at: z.number().nonnegative().max(180),
            kind: z.enum(["pop", "scratch", "thud", "chime", "sting"]),
          })
          .strict(),
      )
      .max(24),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.music === "recorded" && (!s.track || s.cues.length))
      ctx.addIssue({
        code: "custom",
        message:
          "Recorded scores require a licensed track and use recordedCues instead of synthetic cues",
      });
    if (s.music !== "recorded" && (s.track || s.recordedCues || s.ducks))
      ctx.addIssue({
        code: "custom",
        message: "Recorded assets and ducks require music: recorded",
      });
  });
export type Soundtrack = z.infer<typeof SoundtrackSchema>;
export const AUDIO_RENDER_VERSION = "recorded-score-v2-10ms-ducks-peak-limited";
export const AudioLufsSchema = z.number().min(-30).max(-12);
const ffmpeg = promisify(execFile);
export async function measureAudioLoudness(file: string, target = -18) {
  AudioLufsSchema.parse(target);
  const { stderr } = await ffmpeg(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-vn",
      "-af",
      `loudnorm=I=${target}:TP=-2:LRA=7:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { timeout: 180000, maxBuffer: 32000 },
  );
  const match = stderr.match(/\{\s*"input_i"[\s\S]+?\}/);
  if (!match) throw new Error("Audio loudness measurement unavailable");
  const stats = JSON.parse(match[0]) as Record<string, string>;
  for (const k of [
    "input_i",
    "input_tp",
    "input_lra",
    "input_thresh",
    "target_offset",
  ])
    if (!Number.isFinite(Number(stats[k])))
      throw new Error("Cannot master a silent or unmeasurable audio track");
  return stats;
}
export async function masterAudio(file: string, target?: number) {
  if (target === undefined) return file;
  const s = await measureAudioLoudness(file, target);
  const probe = JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "json",
      file,
    ]),
  ) as { streams: { duration?: string }[] };
  const duration = Number(probe.streams[0]?.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Video duration unavailable for audio mastering");
  const temp = resolve(dirname(file), "mastered.tmp.mp4");
  const filter = `loudnorm=I=${target}:TP=-2:LRA=7:measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true,aresample=48000,alimiter=limit=0.75:level=false:latency=true`;
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    filter,
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    // Dynamic loudnorm flushes a 100ms filter tail. Keep the exact video timeline.
    "-t",
    String(duration),
    "-movflags",
    "+faststart",
    temp,
  ]);
  await rename(temp, file);
  // AAC reconstruction can overshoot short Foley transients after limiting.
  // Verify the encoded result and trim only the required gain, preserving frames.
  for (let pass = 0; pass < 2; pass++) {
    const measured = await measureAudioLoudness(file, target);
    const peak = Number(measured.input_tp);
    if (peak <= -1.5) break;
    await command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-af",
      `volume=${(-1.8 - peak).toFixed(3)}dB`,
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-t",
      String(duration),
      "-movflags",
      "+faststart",
      temp,
    ]);
    await rename(temp, file);
  }
  return file;
}
export function checkSoundtrack(score: Soundtrack, duration: number) {
  if (
    score.cues.some((c) => c.at >= duration) ||
    (score.musicUntil !== undefined && score.musicUntil > duration) ||
    [...(score.recordedCues ?? []), ...(score.ducks ?? [])].some(
      (c) => c.at + c.duration > duration + 1e-6,
    )
  )
    throw new Error("Soundtrack timing must be inside the video");
}

export function scoreWav(score: Soundtrack, duration: number): Buffer {
  if (score.music === "recorded")
    throw new Error("Recorded scores cannot use the procedural synthesizer");
  checkSoundtrack(score, duration);
  const rate = 48000,
    n = Math.round(duration * rate);
  const wav = Buffer.alloc(44 + n * 4);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(n * 4, 40);
  const melody = [0, 7, 4, 9, 7, 4, 2, 7];
  const tau = 2 * Math.PI,
    beat = score.music === "suspense" ? 0.5 : 0.3125;
  const until = score.musicUntil ?? duration;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    if (score.music !== "none" && t < until) {
      const k = Math.floor(t / beat),
        age = t - k * beat;
      const f =
        score.music === "suspense"
          ? 146.83 * (k % 2 ? 1.05946 : 1)
          : 261.63 * Math.pow(2, melody[k % melody.length]! / 12);
      const env = Math.min(1, age / 0.004) * Math.exp(-age * 15);
      v +=
        0.095 *
        env *
        (Math.sin(tau * f * age) + 0.25 * Math.sin(tau * f * 2 * age));
      v +=
        0.04 *
        Math.min(1, age / 0.004) *
        Math.exp(-age * 20) *
        Math.sin(tau * 65.4 * age);
      v *= Math.min(1, (until - t) / 0.018);
    }
    for (const c of score.cues) {
      const a = t - c.at;
      if (a < 0 || a > 0.8) continue;
      const attack = Math.min(1, a / 0.003);
      if (c.kind === "pop")
        v +=
          0.25 *
          attack *
          Math.exp(-a * 28) *
          Math.sin(tau * (740 * a - 650 * a * a));
      if (c.kind === "thud")
        v +=
          0.3 *
          attack *
          Math.exp(-a * 17) *
          Math.sin(tau * (90 * a - 30 * a * a));
      if (c.kind === "scratch")
        v +=
          0.18 *
          attack *
          Math.exp(-a * 12) *
          (Math.sin(tau * (1800 * a - 2400 * a * a)) +
            0.4 * Math.sin(tau * 3177 * a));
      if (c.kind === "chime")
        v +=
          0.19 *
          attack *
          Math.exp(-a * 7) *
          (Math.sin(tau * 1046.5 * a) + 0.45 * Math.sin(tau * 1568 * a));
      if (c.kind === "sting")
        v +=
          0.13 *
          attack *
          Math.exp(-a * 5) *
          (Math.sin(tau * 261.63 * a) +
            Math.sin(tau * 311.13 * a) +
            Math.sin(tau * 369.99 * a));
    }
    const fade = Math.min(1, t / 0.005, (duration - t) / 0.02);
    // Bound before PCM conversion; consistent stereo, with no loudness jumps.
    const sample = Math.round(Math.tanh(v) * fade * 32767);
    wav.writeInt16LE(sample, 44 + i * 4);
    wav.writeInt16LE(sample, 46 + i * 4);
  }
  return wav;
}

export async function applySoundtrack(
  file: string,
  duration: number,
  score?: Soundtrack,
) {
  if (!score) return file;
  if (score.music === "recorded")
    return applyRecordedSoundtrack(file, duration, score);
  const dir = dirname(file),
    audio = resolve(dir, "score.wav"),
    temp = resolve(dir, "scored.tmp.mp4");
  await atomic(audio, scoreWav(score, duration));
  // Replace audio explicitly: native model speech/music is never layered below the score.
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    file,
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
    "-ar",
    "48000",
    "-t",
    String(duration),
    "-movflags",
    "+faststart",
    temp,
  ]);
  await rename(temp, file);
  return file;
}

export async function soundtrackAssets(score?: Soundtrack) {
  if (score?.music !== "recorded") return [];
  return Promise.all(
    [score.track!.file, ...(score.recordedCues ?? []).map((c) => c.file)].map(
      async (file) => ({ file, sha256: await fileHash(file) }),
    ),
  );
}

async function applyRecordedSoundtrack(
  file: string,
  duration: number,
  score: Soundtrack,
) {
  checkSoundtrack(score, duration);
  const track = score.track!;
  await soundtrackAssets(score);
  const cues = score.recordedCues ?? [];
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", file];
  for (const source of [track.file, ...cues.map((c) => c.file)]) {
    const probe = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        source,
      ]),
    ) as { format: { duration: string } };
    const sourceDuration = Number(probe.format.duration);
    const index = args.filter((a) => a === "-i").length - 1;
    const start = index === 0 ? track.start : cues[index - 1]!.start;
    const length =
      index === 0 ? (score.musicUntil ?? duration) : cues[index - 1]!.duration;
    if (
      !Number.isFinite(sourceDuration) ||
      start + length > sourceDuration + 0.05
    )
      throw new Error(
        `Recorded audio excerpt exceeds source duration: ${source}`,
      );
    args.push("-i", source);
  }
  const until = score.musicUntil ?? duration;
  // Piecewise gain with short ramps prevents clicks at punchline music drops.
  let envelope = "1";
  for (const d of score.ducks ?? []) {
    const gain = 10 ** (d.gainDb / 20),
      ramp = Math.min(0.06, d.duration / 3),
      end = d.at + d.duration;
    envelope += `*(if(lt(t,${d.at}),1,if(lt(t,${d.at + ramp}),1-(1-${gain})*(t-${d.at})/${ramp},if(lt(t,${end - ramp}),${gain},if(lt(t,${end}),${gain}+(1-${gain})*(t-${end - ramp})/${ramp},1)))))`;
  }
  const filters = [
    `[1:a]atrim=start=${track.start}:duration=${until},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-21:TP=-4:LRA=7,atrim=duration=${until},volume=${track.gainDb}dB,aresample=48000,asetnsamples=n=480:p=0,volume='${envelope}':eval=frame,afade=t=in:d=0.008,afade=t=out:st=${Math.max(0, until - 0.08)}:d=0.08,apad,atrim=duration=${duration}[music]`,
  ];
  cues.forEach((c, i) => {
    const fade = Math.min(0.04, c.duration / 4);
    filters.push(
      `[${i + 2}:a]atrim=start=${c.start}:duration=${c.duration},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-20:TP=-4:LRA=7,atrim=duration=${c.duration},volume=${c.gainDb}dB,afade=t=in:d=0.008,afade=t=out:st=${c.duration - fade}:d=${fade},adelay=${Math.round(c.at * 1000)}:all=1[fx${i}]`,
    );
  });
  filters.push(
    `[music]${cues.map((_, i) => `[fx${i}]`).join("")}amix=inputs=${cues.length + 1}:normalize=0:duration=first,alimiter=limit=.79:level=false:latency=true[a]`,
  );
  const temp = resolve(dirname(file), "recorded-score.tmp.mp4");
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    String(duration),
    "-movflags",
    "+faststart",
    temp,
  );
  await command("ffmpeg", args);
  await rename(temp, file);
  await atomic(
    resolve(dirname(file), "audio-provenance.json"),
    JSON.stringify(
      { score, assets: await soundtrackAssets(score), duration },
      null,
      2,
    ),
  );
  return file;
}
