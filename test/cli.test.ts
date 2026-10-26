import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpecSchema, template, planExperiment } from "../src/spec.js";
import { initProject, readRecipe } from "../src/project.js";
import { LocalImages } from "../src/provider.js";
import { uvArtifact, setup, runtimePaths } from "../src/runtime.js";
import { hash } from "../src/io.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../../bin/run.js", import.meta.url));
async function cli(args: string[], cwd?: string) {
  const { stdout, stderr } = await exec(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, OPENAI_API_KEY: "" },
    timeout: 60_000,
  });
  return { ...JSON.parse(stdout), stderr };
}
test("the default recipe chooses the approved subtle DepthFlow settings", () => {
  const s = template("story");
  assert.equal(s.video.parallaxEngine, "depthflow");
  assert.equal(s.video.parallaxIntensity, 0.105);
  assert.equal(s.video.audio, "silent");
  assert.ok(!planExperiment(s).caption.includes("paleoflux"));
  const b = template("battle");
  assert.equal(b.video.parallaxIntensity, 0.15);
  assert.equal(planExperiment(b).scenes[0]?.layout, "split");
});
test("project recipes resolve local photos relative to the recipe, independent of cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-project-"));
  try {
    const initialized = await initProject(
      join(dir, "project with spaces"),
      "story",
      true,
    );
    const spec = await readRecipe(initialized.recipe),
      ids = planExperiment(spec).assets.map((a) => a.id);
    const local = await LocalImages.fromSpec(spec, ids);
    assert.equal(local.paid, false);
    const bytes = (await local.generate(planExperiment(spec).assets[0]!)).bytes;
    assert.equal(
      hash(bytes),
      hash(await readFile(spec.image.files![ids[0]!]!)),
    );
    const planned = await cli(
      ["--project", initialized.directory, "plan", "--json", "--no-input"],
      tmpdir(),
    );
    assert.equal(planned.data.paidImageRequests, 0);
    assert.equal(planned.data.assetIds.length, 3);
    await assert.rejects(
      initProject(initialized.directory, "story", true),
      /already contains/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("paid generation is a plan until --execute, with no key or runtime required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-paid-plan-"));
  try {
    await initProject(dir, "story");
    const x = await cli(["--project", dir, "create", "--id", "demo", "--json"]);
    assert.equal(x.ok, true);
    assert.equal(x.data.executed, false);
    assert.equal(x.data.paidImageRequests, 3);
    await assert.rejects(
      cli(["--project", dir, "create", "--id", "demo", "--execute"]),
      (e: unknown) => {
        const error = e as { code: number; stderr: string };
        assert.equal(error.code, 3);
        assert.equal(JSON.parse(error.stderr).error.code, "SETUP_REQUIRED");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("setup dry-run has no filesystem side effects and uses pinned bootstrap checksums", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-setup-plan-")),
    old = process.env.SIMPLE_VIDEO_HOME;
  try {
    process.env.SIMPLE_VIDEO_HOME = join(dir, "not-created");
    const plan = await setup({ dryRun: true });
    assert.equal(plan.executed, false);
    await assert.rejects(readFile(join(runtimePaths().home, "setup.json")));
    for (const [os, cpu] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const) {
      const artifact = uvArtifact(os, cpu);
      assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(
        artifact.url.startsWith(
          "https://github.com/astral-sh/uv/releases/download/0.13.5/",
        ),
      );
    }
    assert.throws(() => uvArtifact("freebsd", "arm"), /Unsupported/);
  } finally {
    if (old === undefined) delete process.env.SIMPLE_VIDEO_HOME;
    else process.env.SIMPLE_VIDEO_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});
test("local CLI create, cached rerender and export work from a foreign cwd without credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-e2e-"));
  try {
    await initProject(dir, "loop", true);
    const path = join(dir, "simple-video.json"),
      raw = JSON.parse(await readFile(path, "utf8"));
    raw.video = {
      ...raw.video,
      width: 180,
      height: 320,
      fps: 24,
      motion: "static",
    };
    raw.duration = 2;
    await writeFile(path, JSON.stringify(raw));
    const created = await cli(
      ["--project", dir, "create", "--id", "local-smoke", "--quiet"],
      tmpdir(),
    );
    assert.equal(created.data.status, "ready");
    assert.equal(created.data.requests, 0);
    assert.equal(created.data.report.frames, 48);
    const variant = await cli(
      [
        "--project",
        dir,
        "render",
        "--run",
        "local-smoke",
        "--motion",
        "zoom",
        "--quiet",
      ],
      tmpdir(),
    );
    assert.equal(variant.data.paidRequests, 0);
    assert.notEqual(variant.data.report.sha256, created.data.report.sha256);
    const out = await cli(
      [
        "--project",
        dir,
        "export",
        "--run",
        "local-smoke",
        "--output",
        join(dir, "review"),
      ],
      tmpdir(),
    );
    const exportedVariant = await cli(
      [
        "--project",
        dir,
        "export",
        "--run",
        "local-smoke",
        "--variant",
        variant.data.variant,
        "--output",
        join(dir, "variants-review"),
      ],
      tmpdir(),
    );
    assert.equal(exportedVariant.data.sha256, variant.data.report.sha256);
    assert.equal(out.data.published, false);
    assert.equal(
      hash(await readFile(out.data.video)),
      created.data.report.sha256,
    );
    await assert.rejects(
      cli([
        "--project",
        dir,
        "export",
        "--run",
        "local-smoke",
        "--output",
        join(dir, "review"),
      ]),
      /EEXIST/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("invalid recipe fields and run traversal are rejected with structured errors", async () => {
  assert.throws(() =>
    SpecSchema.parse({ ...template("story"), unexpected: true }),
  );
  await assert.rejects(cli(["status", "--run", "../outside"]), (e: unknown) => {
    const error = e as { stderr: string };
    assert.equal(JSON.parse(error.stderr).ok, false);
    return true;
  });
});

test("the portable skill copies into a new directory and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-skill-"));
  try {
    const destination = join(dir, "nested", "simple-video");
    const response = await cli(["skill", "--output", destination, "--json"]);
    assert.equal(response.data.destination, destination);
    assert.match(
      await readFile(join(destination, "SKILL.md"), "utf8"),
      /name: simple-video/,
    );
    await assert.rejects(
      cli(["skill", "--output", destination]),
      /already exists/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
