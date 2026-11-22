import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function metadata(tag: string, version: string) {
  const module = resolve("scripts/release.mjs");
  const source = `import {releaseMetadata} from ${JSON.stringify(pathToFileURL(module).href)}; const p=${readFileSync("package.json", "utf8")}; p.version=${JSON.stringify(version)}; console.log(JSON.stringify(releaseMetadata(${JSON.stringify(tag)},p)));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}
test("release tags map stable, prerelease and numeric identifiers to safe npm channels", () => {
  assert.equal(metadata("video-v1.2.3", "1.2.3").distTag, "latest");
  assert.equal(metadata("video-v1.2.3-beta.1", "1.2.3-beta.1").distTag, "beta");
  assert.equal(metadata("video-v1.2.3-rc.0", "1.2.3-rc.0").distTag, "rc");
  assert.equal(metadata("video-v1.2.3-0", "1.2.3-0").distTag, "next");
  assert.equal(
    metadata("video-v1.2.3-latest.0", "1.2.3-latest.0").distTag,
    "next",
  );
});
test("invalid or mismatched release tags stop before publishing", () => {
  for (const [tag, version] of [
    ["sdk-v1.2.3", "1.2.3"],
    ["video-v1.2.4", "1.2.3"],
    ["video-v01.2.3", "01.2.3"],
    ["video-v1.2.3-beta.01", "1.2.3-beta.01"],
    ["video-v1.2.3+build", "1.2.3+build"],
  ])
    assert.throws(() => metadata(tag!, version!));
});
test("the executable reports the version that npm will publish", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(
    execFileSync(process.execPath, ["bin/run.js", "--version"], {
      encoding: "utf8",
    }).trim(),
    pkg.version,
  );
});

test("registry verification waits for propagation and rejects mismatched artifacts", () => {
  const module = pathToFileURL(resolve("scripts/verify-published.mjs")).href;
  const source = `
    import assert from 'node:assert/strict';
    import {verifyPublished} from ${JSON.stringify(module)};
    const pkg={name:'@simple-post/video',version:'0.1.0',bin:{'simple-video':'bin/run.js'},dist:{integrity:'sha512-tested'}};
    let requests=0, waits=0;
    const result=await verifyPublished(pkg.name,pkg.version,pkg.dist.integrity,{
      fetcher:async()=>++requests===1?new Response('',{status:404}):Response.json(pkg),
      wait:async()=>{waits++},attempts:2
    });
    assert.equal(result.verified,true);assert.equal(requests,2);assert.equal(waits,1);
    await assert.rejects(verifyPublished(pkg.name,pkg.version,'sha512-wrong',{fetcher:async()=>Response.json(pkg)}),/integrity/);
    await assert.rejects(verifyPublished(pkg.name,pkg.version,undefined,{fetcher:async()=>new Response('',{status:401})}),/HTTP 401/);
    console.log('verified');
  `;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    "verified",
  );
});
test("README examples and skill commands select the latest npm release", () => {
  for (const file of [
    "README.md",
    "examples/README.md",
    "skills/simple-video/SKILL.md",
  ]) {
    const content = readFileSync(file, "utf8");
    const specs = [
      ...content.matchAll(
        /(?:--package[ =]|npm install -g )(@simple-post\/video[^\s`\"]*)/g,
      ),
    ];
    assert.ok(specs.length > 0, `${file} needs an npm install or npx example`);
    for (const [, spec] of specs) {
      assert.equal(
        spec,
        "@simple-post/video@latest",
        `${file} should select latest`,
      );
    }
  }
});
