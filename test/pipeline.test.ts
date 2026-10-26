import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SpecSchema,
  planExperiment,
  template as originalTemplate,
} from "../src/spec.js";
import {
  FixtureImages,
  ProviderError,
  type ImageProvider,
} from "../src/provider.js";
import {
  runExperiment,
  requestTotals,
  imageUsageEstimate,
  type Run,
} from "../src/runner.js";
import { readJson, withLock } from "../src/io.js";
import { rerender } from "../src/rerender.js";
import { depthPanel, parallaxFrame } from "../src/parallax.js";
import sharp from "sharp";

function template(type: Parameters<typeof originalTemplate>[0]) {
  const s = originalTemplate(type);
  s.video.parallaxEngine = "cpu";
  return s;
}

test("battle, story and challenge specifications produce bounded storyboards", () => {
  const b = planExperiment(template("battle"));
  assert.equal(b.assets.length, 7);
  assert.equal(b.scenes.length, 6);
  assert.equal(b.duration, 9);
  assert.equal(planExperiment(template("story")).assets.length, 3);
  assert.equal(planExperiment(template("challenge")).assets.length, 3);
  assert.equal(planExperiment(template("loop")).assets.length, 1);
  assert.equal(planExperiment(template("loop")).scenes.length, 1);
  assert.throws(() =>
    SpecSchema.parse({
      ...template("battle"),
      video: { width: 1000, height: 1000 },
    }),
  );
  assert.throws(() =>
    SpecSchema.parse({ ...template("battle"), unexpected: true }),
  );
});

test("one battle portrait correction reuses every other generated asset", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-portrait-fix-"));
  try {
    const spec = SpecSchema.parse({
      ...template("battle"),
      classicBattle: true,
      heroCount: 1,
      winnerPattern: "custom",
      rounds: [{ count: 1, winner: "hero" }],
      compareDuration: 0.5,
      revealDuration: 0.5,
      video: {
        width: 180,
        height: 320,
        fps: 24,
        motion: "static",
        audio: "synth",
      },
    });
    if (spec.type !== "battle") throw Error("Expected battle");
    const fixture = new FixtureImages();
    let calls = 0;
    const provider: ImageProvider = {
      name: "fixture",
      identity: "portrait-cache-test",
      paid: false,
      async generate(asset) {
        calls++;
        return fixture.generate(asset);
      },
    };
    const first = await runExperiment(spec, provider, { root, id: "original" });
    const corrected = await runExperiment(
      {
        ...spec,
        rounds: [
          {
            count: 1,
            winner: "hero",
            opponentPrompt:
              "A solitary grizzly bear standing alone, no other animals anywhere.",
          },
        ],
      },
      provider,
      { root, id: "corrected" },
    );
    assert.equal(calls, 4, "three original images plus one corrected portrait");
    assert.equal(corrected.assets.hero?.sha256, first.assets.hero?.sha256);
    assert.equal(
      corrected.assets["reveal-0"]?.sha256,
      first.assets["reveal-0"]?.sha256,
    );
    assert.notEqual(
      corrected.assets["opponents-0"]?.key,
      first.assets["opponents-0"]?.key,
    );
    assert.equal(corrected.report?.frames, 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage estimates keep unknown pricing distinct from zero", () => {
  const usage = {
    input_tokens_details: { text_tokens: 100, image_tokens: 0 },
    output_tokens: 400,
  };
  assert.equal(imageUsageEstimate("gpt-image-2.5-flare", usage), 0.0125);
  assert.equal(imageUsageEstimate("future-model", usage), null);
  assert.equal(
    imageUsageEstimate("gpt-image-2.5-flare", { output_tokens: 400 }),
    null,
  );
});

test("final-flip battles reject early switches and repeated or decreasing counts", () => {
  const base = template("battle");
  const rounds = Array.from({ length: 6 }, (_, i) => ({
    count: i + 1,
    winner: i === 5 ? "opponent" : "hero",
  }));
  assert.equal(SpecSchema.parse({ ...base, rounds }).type, "battle");
  assert.equal(
    SpecSchema.parse({
      ...base,
      rounds: rounds.map((r) => ({
        ...r,
        winner: r.winner === "hero" ? "opponent" : "hero",
      })),
    }).type,
    "battle",
  );
  assert.throws(
    () =>
      SpecSchema.parse({
        ...base,
        rounds: rounds.map((r, i) => ({
          ...r,
          winner: i >= 3 ? "opponent" : "hero",
        })),
      }),
    /only the last round/,
  );
  assert.throws(
    () =>
      SpecSchema.parse({
        ...base,
        rounds: rounds.map((r) => ({ ...r, winner: "hero" })),
      }),
    /only the last round/,
  );
  assert.throws(
    () =>
      SpecSchema.parse({ ...base, rounds: [{ count: 1, winner: "opponent" }] }),
    /only the last round/,
  );
  assert.throws(
    () =>
      SpecSchema.parse({
        ...base,
        rounds: rounds.map((r, i) => ({ ...r, count: i === 5 ? 4 : r.count })),
      }),
    /increasing challenger/,
  );
});

test("classic battles retain the six-round reference cadence and group counts", async () => {
  const spec = SpecSchema.parse({
    ...template("battle"),
    heroCount: 2,
    classicBattle: true,
    winnerPattern: "custom",
    compareDuration: 1.5,
    revealDuration: 1.5,
    rounds: Array.from({ length: 6 }, (_, i) => ({
      count: i + 1,
      winner: i < 5 ? "hero" : "opponent",
    })),
    budget: { maxRequests: 13, maxEstimatedUsd: 4, estimatePerImageUsd: 0.25 },
  });
  const plan = planExperiment(spec);
  assert.equal(plan.duration, 18);
  assert.equal(plan.assets.length, 13);
  assert.equal(plan.scenes.length, 12);
  assert.equal(plan.scenes[0]?.caption, "2 vs 1");
  assert.equal(plan.scenes[10]?.caption, "2 vs 6");
  assert.match(plan.assets[0]!.prompt, /Exactly 2/);
  for (let i = 0; i < 6; i++) {
    const compare = plan.scenes[i * 2]!,
      reveal = plan.scenes[i * 2 + 1]!;
    assert.equal(compare.duration, 1.5);
    assert.equal(compare.labels, undefined);
    assert.deepEqual(compare.zoomIntro, { duration: 0.1, factor: 5 });
    assert.equal(compare.panDirection, i % 2 ? 1 : -1);
    assert.equal(reveal.caption, "");
    assert.equal(reveal.panDirection, compare.panDirection);
  }
  const panel = await depthPanel(
    await new FixtureImages().generate(plan.assets[0]!).then((r) => r.bytes),
    await sharp({
      create: { width: 512, height: 512, channels: 3, background: "#777" },
    })
      .png()
      .toBuffer(),
    180,
    320,
  );
  assert.notDeepEqual(
    parallaxFrame(panel, 0, 0.025, 1, "pan", 5),
    parallaxFrame(panel, 0, 0.025, 1, "pan", 1),
  );
});

test("full fixture pipeline, interruption recovery, cache reuse and corruption detection", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-test-"));
  try {
    const spec = template("battle");
    spec.video = {
      parallaxEngine: "cpu",
      parallaxIntensity: 0.105,
      width: 180,
      height: 320,
      fps: 24,
      motion: "zoom",
      audio: "synth",
    };
    if (spec.type !== "battle") throw new Error("Expected battle");
    spec.compareDuration = 0.5;
    spec.revealDuration = 0.5;
    const fixture = new FixtureImages();
    let calls = 0;
    const provider: ImageProvider = {
      name: "test",
      identity: "test-paid",
      paid: true,
      async generate(asset, s, saveResponse) {
        calls++;
        const result = await fixture.generate(asset);
        await saveResponse(
          JSON.stringify({
            data: [{ b64_json: result.bytes.toString("base64") }],
            usage: { output_tokens: 10 },
          }),
        );
        if (calls === 2)
          throw new ProviderError(
            "Simulated interruption after saved response",
            true,
          );
        return result;
      },
    };
    await assert.rejects(
      runExperiment(spec, provider, { root, id: "test-battle" }),
      /Simulated interruption/,
    );
    const failed = await readJson<Run>(
      resolve(root, "runs/test-battle/run.json"),
    );
    assert.equal(failed.status, "failed");
    assert.equal(requestTotals(failed).requests, 2);
    const run = await runExperiment(spec, provider, {
      root,
      id: "test-battle",
    });
    assert.equal(run.status, "ready");
    assert.equal(calls, 7);
    assert.equal(run.report?.frames, 72);
    assert.equal(run.report?.duration, 3);
    await runExperiment(spec, provider, { root, id: "test-battle" });
    assert.equal(calls, 7, "resume must not make another paid request");
    const originalRun = await readFile(
      resolve(root, "runs/test-battle/run.json"),
    );
    let depths = 0;
    const options = {
      root,
      estimateDepth: async (image: Buffer) => {
        depths++;
        const { width, height } = await sharp(image).metadata();
        return sharp(
          Buffer.from(
            `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#333"/><ellipse cx="50%" cy="50%" rx="25%" ry="30%" fill="white"/></svg>`,
          ),
        )
          .png()
          .toBuffer();
      },
    };
    const variant = await rerender(
      "test-battle",
      { motion: "parallax", parallaxEngine: "cpu" },
      options,
    );
    assert.equal(variant.paidRequests, 0);
    assert.equal(calls, 7);
    assert.equal(depths, 7, "the shared hero must reuse its depth map");
    assert.equal(variant.report.frames, 72);
    assert.notEqual(variant.report.sha256, run.report!.sha256);
    assert.deepEqual(
      await readFile(resolve(root, "runs/test-battle/run.json")),
      originalRun,
      "render-only must preserve generation state",
    );
    await rerender(
      "test-battle",
      { motion: "parallax", parallaxEngine: "cpu" },
      options,
    );
    assert.equal(depths, 7, "rerender must reuse depth and video caches");
    await assert.rejects(
      rerender(
        "test-battle",
        { motion: "parallax", parallaxStrength: 0.5 },
        options,
      ),
    );
    await assert.rejects(
      runExperiment({ ...spec, name: "Different experiment" }, provider, {
        root,
        id: "test-battle",
      }),
      /different settings/,
    );
    await writeFile(run.assets.hero!.file!, "corrupt");
    await assert.rejects(
      rerender(
        "test-battle",
        { motion: "parallax", parallaxEngine: "cpu" },
        options,
      ),
      /changed or disappeared/,
    );
    await assert.rejects(
      runExperiment(spec, provider, { root, id: "test-battle" }),
      /changed or disappeared/,
    );
    await assert.rejects(
      runExperiment(spec, provider, { root, id: "new-battle" }),
      /changed or disappeared/,
    );
    assert.equal(calls, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parallax moves foreground more than background with stable split-panel dimensions", () => {
  const width = 180,
    height = 320;
  const rgb = Buffer.alloc(width * height * 3, 24);
  const depth = Buffer.alloc(width * height);
  depth.fill(255, 0, (width * height) / 2);
  for (const [cy, channel] of [
    [80, 0],
    [240, 1],
  ] as const)
    for (let y = cy - 8; y < cy + 8; y++)
      for (let x = 82; x < 98; x++) {
        const i = (y * width + x) * 3;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = 0;
        rgb[i + channel] = 255;
      }
  const panel = { width, height, rgb, depth };
  const a = parallaxFrame(panel, 0, 0.05),
    b = parallaxFrame(panel, 1, 0.05);
  const centroid = (frame: Buffer, channel: number) => {
    let sum = 0,
      count = 0;
    for (let i = 0; i < width * height; i++)
      if (frame[i * 3 + channel]! > 200) {
        sum += i % width;
        count++;
      }
    assert.ok(count > 100, "the subject must remain visible");
    return sum / count;
  };
  const near = centroid(b, 0) - centroid(a, 0);
  const far = centroid(b, 1) - centroid(a, 1);
  assert.ok(
    near > far * 4,
    `Expected depth separation: near=${near}, far=${far}`,
  );
  assert.ok(near > 15 && far > 1);
  let last = -Infinity,
    lastY = Infinity;
  for (const progress of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const frame = parallaxFrame(panel, progress, 0.05);
    const x = centroid(frame, 0);
    assert.ok(
      x >= last,
      "straight pan must never reverse horizontal direction",
    );
    last = x;
    // A marker on the vertical centerline must not sway up then down.
    let ySum = 0,
      count = 0;
    for (let i = 0; i < width * height; i++)
      if (frame[i * 3]! > 200) {
        ySum += Math.floor(i / width);
        count++;
      }
    const yy = ySum / count;
    assert.ok(
      yy <= lastY + 0.05,
      "pan must not sway vertically and reverse halfway",
    );
    lastY = yy;
  }
  assert.equal(a.length, width * height * 3);
  const reverse = parallaxFrame(panel, 1, 0.05, -1);
  assert.ok(
    centroid(reverse, 0) < centroid(b, 0),
    "second panel can move in the opposite direction",
  );
  const loopStart = parallaxFrame(panel, 0, 0.05, 1, "orbit");
  const loopEnd = parallaxFrame(panel, 1, 0.05, 1, "orbit");
  assert.deepEqual(loopStart, loopEnd, "loop camera must close exactly");
  assert.notDeepEqual(
    loopStart,
    parallaxFrame(panel, 0.25, 0.05, 1, "orbit"),
    "a loop still needs depth movement",
  );
});

test("single-image loop renders with ambient audio and no extra image generation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-loop-"));
  try {
    const spec = template("loop");
    if (spec.type !== "loop") throw new Error("Expected loop");
    spec.duration = 2;
    spec.video = {
      parallaxEngine: "cpu",
      parallaxIntensity: 0.105,
      width: 180,
      height: 320,
      fps: 24,
      motion: "static",
      audio: "ambient",
      parallaxPath: "orbit",
    };
    const run = await runExperiment(spec, new FixtureImages(), {
      root,
      id: "loop-test",
    });
    assert.equal(Object.keys(run.assets).length, 1);
    const variant = await rerender(
      "loop-test",
      { motion: "parallax", parallaxEngine: "cpu" },
      {
        root,
        estimateDepth: (image) => sharp(image).greyscale().png().toBuffer(),
      },
    );
    assert.equal(variant.report.frames, 48);
    assert.equal(variant.report.audioCodec, "aac");
    assert.equal(variant.paidRequests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uncertain request without a saved response cannot retry automatically", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-uncertain-"));
  let calls = 0;
  const provider: ImageProvider = {
    name: "test",
    identity: "uncertain",
    paid: true,
    async generate() {
      calls++;
      throw new ProviderError("Lost response", true);
    },
  };
  try {
    await assert.rejects(
      runExperiment(template("battle"), provider, { root, id: "uncertain" }),
      /Lost response/,
    );
    await assert.rejects(
      runExperiment(template("battle"), provider, { root, id: "uncertain" }),
      /uncertain paid request/,
    );
    await assert.rejects(
      runExperiment(template("battle"), provider, { root, id: "other-run" }),
      /uncertain paid request in run uncertain/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request preflight and budgets block further paid calls", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-budget-"));
  let calls = 0;
  const provider: ImageProvider = {
    name: "test",
    identity: "budget",
    paid: true,
    async generate() {
      calls++;
      throw new ProviderError("Rejected", false);
    },
  };
  try {
    const spec = template("battle");
    spec.budget.maxRequests = 1;
    await assert.rejects(
      runExperiment(spec, provider, { root }),
      /requires 7 images/,
    );
    assert.equal(calls, 0);
    spec.budget.maxRequests = 7;
    spec.budget.maxEstimatedUsd = 0.01;
    await assert.rejects(runExperiment(spec, provider, { root }), /budget cap/);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writer lock excludes a competing process", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-lock-"));
  try {
    await withLock(root, async () =>
      assert.rejects(
        withLock(root, async () => {}),
        /writer is active/,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contained parallax keeps both photo edges and matching depth visible through the strongest pan", async () => {
  const sharp = (await import("sharp")).default;
  const input = await sharp({
    create: { width: 60, height: 90, channels: 3, background: "white" },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 3, height: 90, channels: 3, background: "red" },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
      {
        input: await sharp({
          create: { width: 3, height: 90, channels: 3, background: "blue" },
        })
          .png()
          .toBuffer(),
        left: 57,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const depth = await sharp({
    create: { width: 60, height: 90, channels: 3, background: "#808080" },
  })
    .png()
    .toBuffer();
  const panel = await depthPanel(input, depth, 180, 320, "contain");
  assert.equal(panel.depth[0], 0);
  assert.ok(Math.abs(panel.depth[160 * 180 + 90]! - 128) < 2);
  for (const t of [0, 0.5, 1]) {
    const frame = parallaxFrame(panel, t, 0.07);
    let red = 0,
      blue = 0;
    for (let i = 0; i < frame.length; i += 3) {
      if (frame[i]! > 200 && frame[i + 1]! < 40 && frame[i + 2]! < 40) red++;
      if (frame[i + 2]! > 200 && frame[i]! < 40 && frame[i + 1]! < 40) blue++;
    }
    assert.ok(
      red > 500 && blue > 500,
      `Both edges survive at ${t}: red=${red}, blue=${blue}`,
    );
  }
});
