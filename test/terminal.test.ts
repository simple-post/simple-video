import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  jsonOutput,
  canConfirm,
  confirmSetup,
  progressText,
  resultText,
} from "../src/terminal.js";

test("terminal output defaults to readable text, while pipes and --json keep the machine contract", () => {
  assert.equal(jsonOutput({}, true), false);
  assert.equal(jsonOutput({}, false), true);
  assert.equal(jsonOutput({ json: true }, true), true);
  assert.equal(jsonOutput({ human: true }, false), false);
  assert.equal(canConfirm({}, false, true, true), true);
  assert.equal(canConfirm({ input: false }, false, true, true), false);
  assert.equal(canConfirm({}, true, true, true), false);
  assert.equal(canConfirm({}, false, false, true), false);
  assert.equal(canConfirm({}, false, true, false), false);
});

test("setup confirmation defaults to no, including empty answers and closed stdin", async () => {
  for (const [answer, expected] of [
    ["yes\n", true],
    [" Y \n", true],
    ["\n", false],
    ["no\n", false],
    ["maybe\n", false],
    [null, false],
  ] as const) {
    const input = new PassThrough(),
      output = new PassThrough();
    let displayed = "";
    output.on("data", (bytes) => {
      displayed += bytes.toString();
    });
    const confirmation = confirmSetup(input, output);
    if (answer === null) input.end();
    else input.write(answer);
    assert.equal(await confirmation, expected);
    assert.match(displayed, /\[y\/N\]/);
    input.destroy();
    output.destroy();
  }
});

test("readable progress names steps and elapsed time; run summaries preserve paid request counts", () => {
  assert.match(
    progressText({
      stage: "setup",
      step: "depthflow",
      status: "complete",
      elapsedMs: 72000,
    })!,
    /DepthFlow.*72s/,
  );
  assert.match(progressText({ stage: "render", scene: "shot-1" })!, /shot-1/);
  const summary = resultText("create", {
    id: "test",
    status: "images-ready",
    requests: 3,
  });
  assert.match(summary, /Paid requests: 3/);
  assert.doesNotMatch(summary, /undefined/);
});
