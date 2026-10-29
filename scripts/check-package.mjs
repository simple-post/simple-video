import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(pkg.private, undefined, "Remove private before publishing");
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.bin["simple-video"], "bin/run.js");
const cache = mkdtempSync(join(tmpdir(), "simple-video-pack-check-"));
let pack;
try {
  pack = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache],
      { encoding: "utf8", maxBuffer: 2_000_000 },
    ),
  )[0];
} finally {
  rmSync(cache, { recursive: true, force: true });
}
assert.equal(pack.name, pkg.name);
assert.equal(pack.version, pkg.version);
const paths = new Set(pack.files.map((file) => file.path));
for (const expected of [
  "package.json",
  "bin/run.js",
  "dist/cli.js",
  "dist/runtime.js",
  "dist/terminal.js",
  "dist/auth.js",
  "dist/auth-file.js",
  "dist/native-credentials.js",
  "dist/credential-worker.js",
  "dist/provider.js",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "skills/simple-video/SKILL.md",
  "docs/setup.md",
])
  assert.ok(
    paths.has(expected),
    `Missing package file ${expected}; run npm run build first`,
  );
for (const path of paths) {
  assert.ok(
    !/(^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials\.json|\.git|\.simple-video|node_modules|dist-test|test)(?:\/|$)/.test(
      path,
    ),
    `Private/development file packed: ${path}`,
  );
  assert.ok(
    !/\.(mp4|mp3|wav|onnx|safetensors|pyc|pem|key)$/.test(path),
    `Runtime/media/credential file packed: ${path}`,
  );
}
const version = execFileSync(process.execPath, ["bin/run.js", "--version"], {
  encoding: "utf8",
}).trim();
assert.equal(version, pkg.version, "The CLI must report the package version");
console.log(
  JSON.stringify({
    name: pack.name,
    version,
    files: paths.size,
    bytes: pack.size,
    validated: true,
  }),
);
