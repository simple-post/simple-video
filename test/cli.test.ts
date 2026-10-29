import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpecSchema, template, planExperiment } from "../src/spec.js";
import { initProject, readRecipe } from "../src/project.js";
import { LocalImages } from "../src/provider.js";
import { uvArtifact, setup, runtimePaths } from "../src/runtime.js";
import { CliError, hash } from "../src/io.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../../bin/run.js", import.meta.url));
async function cli(args: string[], cwd?: string) {
  const { stdout, stderr } = await exec(process.execPath, [bin, ...args], {
    cwd,
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      SIMPLE_VIDEO_CONFIG_DIR: join(
        tmpdir(),
        `simple-video-empty-config-${process.pid}`,
      ),
    },
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

test("init stores explicit prompts, previews them in plans, and rejects missing content without creating files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-content-"));
  try {
    const single = join(dir, "single"),
      prompt =
        "A T. rex trying to eat spaghetti in a tiny Italian restaurant, realistic layered photo";
    await cli([
      "init",
      single,
      "--prompt",
      prompt,
      "--duration",
      "4",
      "--name",
      "Tiny arms",
    ]);
    const spec = await readRecipe(join(single, "simple-video.json"));
    assert.equal(spec.type, "loop");
    if (spec.type !== "loop") throw Error("Expected single image");
    assert.equal(spec.prompt, prompt);
    assert.equal(spec.duration, 4);
    assert.equal(spec.caption, "");
    const planned = await cli(["--project", single, "plan"]);
    assert.equal(planned.data.descriptions[0].prompt, prompt);
    assert.ok(planned.data.assets[0].prompt.includes(prompt));
    const notExecuted = await cli([
      "--project",
      single,
      "create",
      "--id",
      "first",
    ]);
    assert.equal(notExecuted.data.executed, false);
    assert.equal(notExecuted.data.paidImageRequests, 1);
    const slides = join(dir, "slides");
    await cli([
      "init",
      slides,
      "--template",
      "slideshow",
      "--prompt",
      "A triceratops entering a very small gym",
      "--prompt",
      "The same triceratops bending the exercise bike",
      "--caption",
      "Leg day",
      "--caption",
      "Oops",
      "--duration",
      "2",
    ]);
    const story = await readRecipe(join(slides, "simple-video.json"));
    assert.equal(story.type, "story");
    if (story.type !== "story") throw Error("Expected story");
    assert.equal(story.shots.length, 2);
    assert.equal(story.shots[1]?.caption, "Oops");
    assert.ok(!story.character.includes("terrier"));
    const battle = join(dir, "battle");
    await cli([
      "init",
      battle,
      "--template",
      "comparison",
      "--hero",
      "A T. rex",
      "--opponent",
      "woolly mammoths",
      "--setting",
      "An open snowy valley",
    ]);
    const matchup = (await cli(["--project", battle, "plan"])).data;
    assert.equal(matchup.paidImageRequests, 7);
    assert.ok(matchup.assets[0].prompt.includes("T. rex"));
    assert.ok(!matchup.assets[0].prompt.includes("robot"));
    for (const args of [
      [],
      ["--template", "comparison", "--hero", "A rex"],
      ["--template", "slideshow", "--prompt", prompt],
      ["--local", "--prompt", prompt],
    ]) {
      const target = join(dir, "invalid");
      await assert.rejects(
        cli(["init", target, "--json", "--no-input", ...args]),
      );
      await assert.rejects(access(target));
    }
    const recipeFile = join(single, "simple-video.json"),
      raw = JSON.parse(await readFile(recipeFile, "utf8"));
    raw.video = {
      ...raw.video,
      width: 180,
      height: 320,
      fps: 24,
      motion: "static",
    };
    raw.duration = 2;
    await writeFile(recipeFile, JSON.stringify(raw));
    const rendered = await cli([
      "--project",
      single,
      "create",
      "--id",
      "prompt-fixture",
      "--provider",
      "fixture",
      "--quiet",
    ]);
    assert.equal(rendered.data.requests, 0);
    assert.equal(rendered.data.report.frames, 48);
    const run = JSON.parse(
      await readFile(
        join(single, ".simple-video", "runs", "prompt-fixture", "run.json"),
        "utf8",
      ),
    );
    assert.ok(run.plan.assets[0].prompt.includes(prompt));
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

test("setup refuses unapproved downloads before creating its runtime directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-setup-consent-")),
    home = join(dir, "runtime"),
    old = process.env.SIMPLE_VIDEO_HOME;
  try {
    process.env.SIMPLE_VIDEO_HOME = home;
    await assert.rejects(setup({}), (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.code, "CONFIRMATION_REQUIRED");
      return true;
    });
    for (const flags of [
      [],
      ["--json"],
      ["--no-input"],
      ["--human", "--no-input"],
      ["--quiet"],
    ]) {
      await assert.rejects(
        cli(["--home", home, ...flags, "setup"]),
        (e: unknown) => {
          const error = e as { code: number; stdout: string; stderr: string };
          assert.equal(error.code, 2);
          assert.equal(error.stdout, "");
          if (flags.includes("--human")) {
            assert.match(error.stderr, /Install location:/);
            assert.match(error.stderr, /approval/);
            assert.doesNotMatch(error.stderr, /Continue with setup\?/);
          } else {
            const failure = JSON.parse(error.stderr);
            assert.equal(failure.error.code, "CONFIRMATION_REQUIRED");
            assert.equal(failure.error.details.executed, false);
            assert.equal(failure.error.details.plan.paths.home, home);
          }
          return true;
        },
      );
    }
    await assert.rejects(access(home));
    const preview = await cli([
      "--home",
      home,
      "setup",
      "--dry-run",
      "--json",
      "--no-input",
    ]);
    assert.equal(preview.data.executed, false);
    await assert.rejects(access(home));
  } finally {
    if (old === undefined) delete process.env.SIMPLE_VIDEO_HOME;
    else process.env.SIMPLE_VIDEO_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "setup --yes is required to start an unattended installer; dry-run still wins",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "simple-video-setup-yes-")),
      marker = join(dir, "installer-started"),
      uv = join(dir, "fake-uv");
    try {
      // Stop at uv's version check. No package installs or network calls occur.
      await writeFile(
        uv,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1);\n`,
      );
      await chmod(uv, 0o700);
      const args = [
        "--home",
        join(dir, "runtime"),
        "--json",
        "--no-input",
        "setup",
        "--yes",
        "--storage",
        "env",
        "--skip-model",
        "--uv",
        uv,
      ];
      const preview = await cli([...args, "--dry-run"]);
      assert.equal(preview.data.executed, false);
      await assert.rejects(access(marker));
      await assert.rejects(cli(args), (e: unknown) => {
        const error = e as { stderr: string };
        const events = error.stderr
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(events[0].event, "progress");
        assert.equal(events[0].step, "uv");
        assert.equal(events.at(-1).ok, false);
        assert.notEqual(events.at(-1).error.code, "CONFIRMATION_REQUIRED");
        return true;
      });
      assert.equal(await readFile(marker, "utf8"), "started");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("readable output is available for humans and explicit JSON stays parseable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-output-"));
  try {
    const invoke = (args: string[]) =>
      exec(process.execPath, [bin, ...args], {
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          SIMPLE_VIDEO_CONFIG_DIR: join(
            tmpdir(),
            `simple-video-empty-config-${process.pid}`,
          ),
        },
        timeout: 60_000,
      });
    const initialized = await invoke(["--human", "init", dir, "--local"]);
    assert.match(initialized.stdout, /Project created/);
    assert.match(initialized.stdout, /simple-video\.json/);
    assert.doesNotMatch(initialized.stdout, /"ok"/);
    const plan = await invoke(["--human", "--project", dir, "plan"]);
    assert.match(plan.stdout, /Paid image requests: 0/);
    assert.doesNotMatch(plan.stdout, /\$3\.00/);
    const piped = await cli(["--project", dir, "plan"]);
    assert.equal(piped.ok, true);
    const json = await cli(["--project", dir, "plan", "--json"]);
    assert.equal(json.data.paidImageRequests, 0);
    const preview = await invoke([
      "--human",
      "setup",
      "--dry-run",
      "--skip-model",
    ]);
    assert.match(preview.stdout, /deferred until the first parallax render/);
    assert.match(preview.stdout, /Nothing was downloaded or installed/);
    await assert.rejects(
      invoke(["--human", "status", "--run", "../outside"]),
      (e: unknown) => {
        const error = e as { stderr: string };
        assert.match(error.stderr, /^Error: Run ID/);
        assert.doesNotMatch(error.stderr, /"ok"/);
        return true;
      },
    );
    await assert.rejects(invoke(["--human", "--json", "setup", "--dry-run"]));
    const recipeFile = join(dir, "simple-video.json"),
      invalid = JSON.parse(await readFile(recipeFile, "utf8"));
    invalid.video.width = 0;
    await writeFile(recipeFile, JSON.stringify(invalid));
    await assert.rejects(
      invoke(["--human", "--project", dir, "plan"]),
      (e: unknown) => {
        const error = e as { stderr: string };
        assert.match(error.stderr, /Recipe validation failed/);
        assert.match(error.stderr, /video\.width:/);
        assert.doesNotMatch(error.stderr, /"code":/);
        return true;
      },
    );
  } finally {
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
