import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { command } from "../src/io.js";
import {
  scoreWav,
  applySoundtrack,
  masterAudio,
  measureAudioLoudness,
  SoundtrackSchema,
} from "../src/soundtrack.js";
import { SpecSchema, template } from "../src/spec.js";

test("recorded music uses a selected excerpt, ducks for the payoff and keeps original video frames", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "simple-video-recorded-"));
  try {
    const file = resolve(dir, "video.mp4"),
      music = resolve(dir, "music.wav"),
      pcm = resolve(dir, "out.pcm");
    await command("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=180x320:r=24:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=200:duration=3",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-t",
      "3",
      file,
    ]);
    await command("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=900:duration=5",
      music,
    ]);
    const frames = () =>
      command("ffmpeg", [
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-f",
        "framemd5",
        "-",
      ]);
    const before = await frames();
    const track = {
      file: music,
      start: 1,
      gainDb: 0,
      credit: "Fixture credit",
      source: "https://example.com/music",
      license: "https://creativecommons.org/licenses/by/4.0/",
    };
    const score = SoundtrackSchema.parse({
      music: "recorded",
      track,
      cues: [],
      ducks: [{ at: 1, duration: 0.7, gainDb: -30 }],
    });
    await applySoundtrack(file, 3, score);
    assert.equal(await frames(), before);
    await command("ffmpeg", [
      "-v",
      "error",
      "-i",
      file,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "s16le",
      pcm,
    ]);
    const data = await readFile(pcm);
    const rms = (start: number, end: number) => {
      let sum = 0,
        count = 0;
      for (
        let i = Math.round(start * 48000);
        i < Math.round(end * 48000);
        i++
      ) {
        sum += data.readInt16LE(i * 2) ** 2;
        count++;
      }
      return Math.sqrt(sum / count);
    };
    assert.ok(
      rms(1.15, 1.5) < rms(0.3, 0.7) / 10,
      "music becomes quiet exactly during the punchline",
    );
    assert.ok(
      rms(2, 2.4) > rms(1.15, 1.5) * 10,
      "the hook resumes after the duck",
    );
    assert.throws(() =>
      SoundtrackSchema.parse({ music: "recorded", cues: [] }),
    );
    await assert.rejects(
      () =>
        applySoundtrack(file, 3, { ...score, track: { ...track, start: 4 } }),
      /exceeds source duration/,
    );
    assert.throws(() =>
      SpecSchema.parse({
        ...template("loop"),
        duration: 3,
        soundtrack: {
          ...score,
          recordedCues: [
            { file: music, at: 2.9, duration: 0.2, start: 0, gainDb: 0 },
          ],
        },
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sound score has quiet setup, a timed payoff and bounded peaks", () => {
  const wav = scoreWav({ music: "none", cues: [{ at: 1, kind: "chime" }] }, 2);
  assert.equal(wav.length, 44 + 2 * 48000 * 4);
  let before = 0,
    after = 0,
    peak = 0;
  for (let i = 0; i < 96000; i++) {
    const v = Math.abs(wav.readInt16LE(44 + i * 4));
    if (i < 48000) before = Math.max(before, v);
    else after = Math.max(after, v);
    peak = Math.max(peak, v);
  }
  assert.equal(before, 0);
  assert.ok(after > 1000 && peak < 32767);
  assert.throws(() =>
    SpecSchema.parse({
      ...template("loop"),
      duration: 2,
      soundtrack: { music: "playful", musicUntil: 3, cues: [] },
    }),
  );
  assert.throws(() =>
    SpecSchema.parse({
      ...template("loop"),
      duration: 2,
      soundtrack: { music: "none", cues: [{ at: 2, kind: "thud" }] },
    }),
  );
});

test("audio mastering lifts a quiet track to target without changing video frames", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "simple-video-master-"));
  try {
    const file = resolve(dir, "video.mp4");
    await command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=180x320:r=24:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=3",
      "-af",
      "volume=0.03",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-t",
      "3",
      file,
    ]);
    const frames = () =>
      command("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-f",
        "framemd5",
        "-",
      ]);
    const original = await frames();
    assert.ok(Number((await measureAudioLoudness(file)).input_i) < -40);
    await masterAudio(file, -18);
    assert.equal(await frames(), original);
    const measured = await measureAudioLoudness(file);
    assert.ok(Math.abs(Number(measured.input_i) + 18) < 1);
    assert.ok(Number(measured.input_tp) < -1);
    assert.throws(() =>
      SpecSchema.parse({ ...template("loop"), audioLufs: -5 }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("score replaces native audio and preserves video frames through FFmpeg", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "simple-video-score-"));
  try {
    const file = resolve(dir, "video.mp4");
    await command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=180x320:r=24:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-t",
      "2",
      file,
    ]);
    const frames = () =>
      command("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-f",
        "framemd5",
        "-",
      ]);
    const original = await frames();
    await applySoundtrack(file, 2, {
      music: "none",
      cues: [{ at: 1, kind: "chime" }],
    });
    assert.equal(await frames(), original);
    const analysis = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        file,
        "-vn",
        "-af",
        "silencedetect=noise=-60dB:d=0.5",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    );
    // The old continuous sine must disappear; setup stays quiet before the cue.
    assert.equal(analysis.status, 0);
    assert.match(analysis.stderr, /silence_start: 0/);
    assert.match(analysis.stderr, /silence_end: 0\.99|silence_end: 1\./);
    // A high loudness target forces the dynamic limiter; its filter tail must
    // not extend the MP4 beyond the original two-second video timeline.
    await masterAudio(file, -12);
    assert.equal(await frames(), original);
    const duration = Number(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        file,
      ]),
    );
    assert.ok(Math.abs(duration - 2) < 0.04);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
