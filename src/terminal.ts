import { createInterface } from "node:readline";
import { Writable, type Readable } from "node:stream";
import type { setupPlan } from "./runtime.js";
import { CliError } from "./io.js";

type OutputOptions = {
  json?: boolean;
  human?: boolean;
  quiet?: boolean;
  input?: boolean;
};
type Fields = Record<string, any>;

export function jsonOutput(options: OutputOptions, stdoutIsTTY: boolean) {
  return Boolean(options.json || (!options.human && !stdoutIsTTY));
}

export function canConfirm(
  options: OutputOptions,
  json: boolean,
  stdinIsTTY: boolean,
  stderrIsTTY: boolean,
) {
  return !json && options.input !== false && stdinIsTTY && stderrIsTTY;
}

export function setupPreview(plan: ReturnType<typeof setupPlan>) {
  const uv =
    typeof plan.uv === "string"
      ? `existing uv: ${plan.uv}`
      : `uv ${plan.uv.version} from Astral's GitHub release (checksum verified)`;
  return [
    "Set up the local video renderer",
    "",
    `  Install location: ${plan.paths.home}`,
    `  Download tool:    ${uv}`,
    `  Python:           managed ${plan.python}, isolated from system Python`,
    "  Python packages:",
    ...plan.packages.map((name) => `    ${name.replace("==", " ")}`),
    `  Depth model:      ${plan.modelDownload ? plan.model : "deferred until the first parallax render (--skip-model)"}`,
    "",
    `  ${plan.downloadSize}.`,
    "  Existing downloads are reused where possible.",
    "  Python downloads use uv; packages use your Python index (default: PyPI).",
    "  Shell profiles and system Python stay unchanged. No sudo or paid API calls.",
    "  FFmpeg/ffprobe and a working OpenGL 3.3+ driver must be installed separately.",
  ].join("\n");
}

// EOF, an empty answer, and anything except an explicit yes all decline.
export async function confirmSetup(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<boolean> {
  const rl = createInterface({ input, output, terminal: false });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      rl.once("close", () => resolve(false));
      rl.once("SIGINT", () =>
        reject(
          new CliError(
            "CANCELLED",
            130,
            "Setup cancelled. Nothing was installed.",
          ),
        ),
      );
      rl.question("\nContinue with setup? [y/N] ", (answer) =>
        resolve(/^(y|yes)$/i.test(answer.trim())),
      );
    });
  } finally {
    rl.close();
  }
}

export async function askText(
  label: string,
  hidden = false,
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  const muted = hidden
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : undefined;
  const rl = createInterface({
    input,
    output: muted ?? output,
    terminal: hidden,
  });
  try {
    output.write(label);
    return await new Promise<string>((resolve, reject) => {
      rl.once("close", () =>
        reject(new CliError("CANCELLED", 130, "Cancelled. Nothing was saved.")),
      );
      rl.once("SIGINT", () =>
        reject(new CliError("CANCELLED", 130, "Cancelled. Nothing was saved.")),
      );
      rl.question("", (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
    if (hidden) {
      output.write("\n");
      muted?.destroy();
    }
  }
}

const seconds = (ms: number) =>
  ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
const setupSteps: Record<string, string> = {
  uv: "Prepare uv download tool",
  python: "Prepare isolated Python environment",
  depthflow: "Install and verify DepthFlow + PyTorch",
  "depth-model": "Download and load the depth model",
};

export function progressText(event: Fields): string | undefined {
  if (event.stage === "setup") {
    const name = setupSteps[event.step] ?? event.step;
    return event.status === "complete"
      ? `  ✓ ${name} (${seconds(event.elapsedMs ?? 0)})`
      : `  ${name}…`;
  }
  if (event.stage === "preflight") return "  Check graphics support…";
  if (event.stage === "depth" || event.step === "depth-model")
    return "  Prepare local depth model…";
  if (event.stage === "image") {
    const verb = ["reused", "cache-hit"].includes(event.status)
      ? "Reuse cached photo"
      : event.status === "ready"
        ? "✓ Photo ready"
        : "Prepare photo";
    return `  ${verb}: ${event.asset}`;
  }
  if (event.stage === "render") return `  Render scene: ${event.scene}…`;
  if (event.stage === "assemble") return "  Combine scenes and audio…";
  if (event.stage === "validate") return "  Check video quality and timing…";
  if (event.stage === "complete") return undefined; // The final result includes the output path.
  return `  ${event.stage ?? "Working"}${event.step ? `: ${event.step}` : ""}…`;
}

export function resultText(command: string, data: any): string {
  if (command === "auth login")
    return `OpenAI key saved for Simple Video.\n  Location: ${data.path}\n  Storage: private local file, unencrypted (0600 on Unix).\n\nYou can now generate images in any project. No API request was made.`;
  if (command === "auth status")
    return data.configured
      ? `OpenAI key configured.\n  Source: ${data.source}${data.path ? `\n  Location: ${data.path}` : ""}\n  No provider validation request was made.`
      : "No OpenAI key configured. Run simple-video auth login. Local photos need no key.";
  if (command === "auth logout")
    return `${data.removed ? "Saved key removed." : "No saved key to remove."}\n${data.note}`;
  if (command === "setup") {
    if (data.cancelled) return "Setup cancelled. Nothing was installed.";
    if (!data.executed)
      return `${setupPreview(data)}\n\nPreview only. Nothing was downloaded or installed.`;
    return `Setup complete.\n  Runtime: ${data.paths.home}\n\nNext: ${data.next}`;
  }
  if (command === "init")
    return `Project created.\n  Folder: ${data.directory}\n  Recipe: ${data.recipe}\n  Photos: ${data.local ? "local demo artwork; no API key needed" : "AI generation; use auth login once"}${data.local ? "" : `\n\nImage descriptions (${data.promptLocation} in simple-video.json):\n${(data.descriptions ?? []).map((d: Fields) => `  ${d.id}: ${d.prompt}`).join("\n")}`}\n\nNext: ${data.next}`;
  if (command === "plan" || (command === "create" && data.executed === false)) {
    const rows = [
      data.name,
      `  Video: ${data.duration}s · ${data.scenes.length} scene(s) · ${data.assetIds.length} photo(s)`,
      `  Paid image requests: ${data.paidImageRequests}`,
    ];
    if (data.paidImageRequests)
      rows.push(
        `  Image model: ${data.imageModel}`,
        `  Estimated cost: $${Number(data.estimatedUsd).toFixed(2)} (your recipe's estimate, not a quote)`,
      );
    rows.push(
      `  Budget: ${data.budgetFits ? "within recipe limits" : "EXCEEDS recipe limits"}`,
      `  Photo IDs: ${data.assetIds.join(", ")}`,
      ...(data.descriptions?.length
        ? [
            "",
            "Image descriptions:",
            ...data.descriptions.map((d: Fields) => `  ${d.id}: ${d.prompt}`),
          ]
        : []),
      "",
      data.next ?? "Review the recipe before running create.",
    );
    return rows.join("\n");
  }
  if (command === "doctor") {
    const rows = [
      data.ready ? "Dependencies ready." : "Setup needs attention.",
    ];
    for (const check of data.checks)
      rows.push(`  ${check.available ? "✓" : "Missing:"} ${check.name}`);
    rows.push(
      `  ${data.depthflowPresent ? "✓ DepthFlow" : "Missing: DepthFlow"}`,
    );
    if (data.graphics)
      rows.push(
        `  ✓ GPU render verified (${data.graphics.frames} test frames)`,
      );
    rows.push(
      `  Runtime: ${data.paths.home}`,
      `  OpenAI key: ${data.openaiKeyPresent ? `configured (${data.authentication?.source ?? "environment"})` : "not set; run simple-video auth login for AI images"}`,
      "",
      data.hint,
    );
    return rows.join("\n");
  }
  if (command === "list")
    return data.length
      ? data
          .map(
            (run: Fields) =>
              `${run.id}  ${run.status}  ${run.name}${run.output ? `\n  ${run.output}` : ""}`,
          )
          .join("\n")
      : "No videos yet. Start with simple-video init ./my-video --local";
  if (["create", "render", "status"].includes(command)) {
    const rows = [
      command === "render"
        ? "Video variant ready."
        : `Video ${data.id}: ${data.status}.`,
    ];
    if (data.output) rows.push(`  Video: ${data.output}`);
    if (data.report)
      rows.push(
        `  ${data.report.duration}s · ${data.report.width}×${data.report.height} · ${data.report.frames} frames`,
      );
    if (data.variant) rows.push(`  Variant: ${data.variant}`);
    rows.push(`  Paid requests: ${data.paidRequests ?? data.requests ?? 0}`);
    if (data.error) rows.push(`  Error: ${data.error}`);
    return rows.join("\n");
  }
  if (command === "export")
    return `Video exported.\n  Video: ${data.video}\n  Metadata: ${data.manifest}\n\n${data.next}`;
  if (command === "skill")
    return `Agent skill: ${data.destination ?? data.source}\n  Entry: ${data.entry}`;
  // Schemas remain JSON even in human mode so they can be pasted into an editor.
  return JSON.stringify(data, null, 2);
}

export class Terminal {
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(private options: () => OutputOptions) {}
  get json() {
    return jsonOutput(this.options(), Boolean(process.stdout.isTTY));
  }
  stop() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  log(event: unknown) {
    this.stop();
    if (this.options().quiet) return;
    if (this.json) {
      process.stderr.write(
        JSON.stringify({ event: "progress", ...(event as object) }) + "\n",
      );
      return;
    }
    const text = progressText(event as Fields);
    if (!text) return;
    process.stderr.write(text + "\n");
    if ((event as Fields).status !== "complete") {
      const started = Date.now();
      this.heartbeat = setInterval(
        () =>
          process.stderr.write(
            `  Still working (${seconds(Date.now() - started)} elapsed)…\n`,
          ),
        30_000,
      );
      this.heartbeat.unref();
    }
  }
  result(command: string, data: unknown) {
    this.stop();
    process.stdout.write(
      (this.json
        ? JSON.stringify({ ok: true, command, data }, null, 2)
        : resultText(command, data)) + "\n",
    );
  }
  error(error: {
    code: string;
    message: string;
    issues?: { path: PropertyKey[]; message: string }[];
    details?: unknown;
  }) {
    this.stop();
    const message = error.issues?.length
      ? `Recipe validation failed.\n${error.issues.map((issue) => `  ${issue.path.map(String).join(".") || "recipe"}: ${issue.message}`).join("\n")}`
      : error.message;
    process.stderr.write(
      this.json
        ? JSON.stringify({ ok: false, error }) + "\n"
        : `Error: ${message}\n`,
    );
  }
}
