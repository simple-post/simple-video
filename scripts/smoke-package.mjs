import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball)
  throw Error(
    "Usage: node scripts/smoke-package.mjs /absolute/path/to/package.tgz",
  );
const expected = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const directory = mkdtempSync(join(tmpdir(), "simple-video-package-"));
const env = {
  ...process.env,
  OPENAI_API_KEY: "",
  ONNXRUNTIME_NODE_INSTALL: "skip",
  SIMPLE_VIDEO_HOME: join(directory, "runtime"),
  SIMPLE_VIDEO_CONFIG_DIR: join(directory, "config"),
  npm_config_cache: join(directory, "npm-cache"),
};
try {
  const prefix = join(directory, "install");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      resolve(tarball),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 },
  );
  const installedRoot = join(prefix, "node_modules", expected.name);
  const installed = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installed.name, expected.name);
  assert.equal(installed.version, expected.version);
  const binary = join(installedRoot, "bin", "run.js");
  const invoke = (args) =>
    execFileSync(process.execPath, [binary, ...args], {
      env,
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      encoding: "utf8",
    });
  assert.equal(invoke(["--version"]).trim(), expected.version);
  const described = join(directory, "described");
  const prompt = "A red fox sleeping on a mossy log beside a mountain lake";
  invoke(["init", described, "--prompt", prompt]);
  const preview = JSON.parse(
    invoke(["--project", described, "plan", "--json", "--no-input"]),
  );
  assert.equal(preview.data.descriptions[0].prompt, prompt);
  assert.equal(preview.data.paidImageRequests, 1);
  assert.equal(
    JSON.parse(invoke(["auth", "status", "--json", "--no-input"])).data
      .configured,
    false,
  );
  const project = join(directory, "project");
  invoke(["init", project, "--template", "single", "--local"]);
  const recipeFile = join(project, "simple-video.json");
  const recipe = JSON.parse(readFileSync(recipeFile, "utf8"));
  recipe.video = {
    ...recipe.video,
    width: 180,
    height: 320,
    fps: 24,
    motion: "static",
  };
  recipe.duration = 2;
  writeFileSync(recipeFile, JSON.stringify(recipe));
  const created = JSON.parse(
    invoke([
      "--project",
      project,
      "create",
      "--id",
      "package-smoke",
      "--quiet",
    ]),
  );
  assert.equal(created.data.status, "ready");
  assert.equal(created.data.requests, 0);
  assert.equal(created.data.report.frames, 48);
  const exported = JSON.parse(
    invoke([
      "--project",
      project,
      "export",
      "--run",
      "package-smoke",
      "--output",
      join(directory, "review"),
    ]),
  );
  assert.equal(exported.data.published, false);
  assert.ok(existsSync(exported.data.video));
  invoke(["skill", "--output", join(directory, "agent-skill")]);
  assert.ok(existsSync(join(directory, "agent-skill", "SKILL.md")));
  console.log(
    JSON.stringify({
      package: installed.name,
      version: installed.version,
      installedCli: true,
      localRender: true,
      skillExport: true,
      paidRequests: 0,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
