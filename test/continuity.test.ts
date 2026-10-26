import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SpecSchema, template, planExperiment } from "../src/spec.js";
import {
  OpenAIImages,
  FixtureImages,
  type ImageProvider,
} from "../src/provider.js";
import { runExperiment } from "../src/runner.js";
import { hash } from "../src/io.js";

test("linked slides pass the exact previous image, reuse it, and invalidate dependent edits", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "simple-video-chain-"));
  try {
    const base = template("story");
    if (base.type !== "story") throw Error("story");
    const spec = SpecSchema.parse({
      ...base,
      video: {
        width: 180,
        height: 320,
        fps: 24,
        motion: "static",
        audio: "silent",
      },
      shots: base.shots
        .slice(0, 2)
        .map((s, i) => ({ ...s, duration: 0.5, referencePrevious: i > 0 })),
    });
    assert.equal(planExperiment(spec).assets[1]?.referenceAsset, "shot-0");
    const fixture = new FixtureImages();
    let calls = 0;
    const references: (string | undefined)[] = [];
    const provider: ImageProvider = {
      name: "fixture",
      identity: "chain-test",
      paid: false,
      async generate(a, _s, _save, ref) {
        calls++;
        references.push(ref ? hash(ref) : undefined);
        const g = await fixture.generate(a);
        return {
          ...g,
          bytes: await sharp(g.bytes)
            .modulate({ brightness: 1 + calls * 0.01 })
            .png()
            .toBuffer(),
        };
      },
    };
    const first = await runExperiment(spec, provider, { root, id: "first" });
    assert.deepEqual(references, [undefined, first.assets["shot-0"]?.sha256]);
    await runExperiment(spec, provider, { root, id: "cached" });
    assert.equal(calls, 2);
    if (spec.type !== "story") throw Error("story");
    await runExperiment(
      {
        ...spec,
        shots: spec.shots.map((s, i) =>
          i === 0
            ? { ...s, prompt: s.prompt + " Additional foreground lamp." }
            : s,
        ),
      },
      provider,
      { root, id: "changed" },
    );
    assert.equal(
      calls,
      4,
      "changed base image must invalidate downstream edit even when edit prompt stays the same",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image edits send reference pixels as multipart while generations remain JSON", async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "unit-test";
  try {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const calls: string[] = [];
    const client = new OpenAIImages(async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/edits")) {
        const form = init?.body as FormData;
        assert.equal(
          hash(Buffer.from(await (form.get("image[]") as File).arrayBuffer())),
          hash(png),
        );
        assert.equal(form.get("model"), "gpt-image-2.5-flare");
        assert.ok(!(init?.headers as Record<string, string>)["Content-Type"]);
      } else {
        assert.equal(typeof init?.body, "string");
      }
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    });
    const spec = template("story"),
      a = planExperiment(spec).assets[0]!;
    await client.generate(a, spec, async () => {}, png);
    await client.generate(a, spec, async () => {});
    assert.ok(calls[0]?.endsWith("/edits"));
    assert.ok(calls[1]?.endsWith("/generations"));
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  }
});
