import { homedir, platform, arch } from "node:os";
import { resolve, join } from "node:path";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  atomic,
  CliError,
  command,
  hash,
  readJson,
  withLock,
  writeJson,
  cliCommand,
} from "./io.js";
import { uvAssets } from "./uv-assets.js";

export const UV_VERSION = "0.13.5";
export const PYTHON_VERSION = "3.12";
export const PYTHON_PACKAGES = [
  "depthflow==0.9.1",
  "shaderflow==0.9.1",
  "broken-source==0.9.1",
  "torch==2.7.1",
  "torchvision==0.22.1",
];

export function runtimePaths(home = process.env.SIMPLE_VIDEO_HOME) {
  const base = resolve(
    home ??
      join(
        process.env.XDG_CACHE_HOME ??
          (platform() === "darwin"
            ? join(homedir(), "Library", "Caches")
            : platform() === "win32"
              ? (process.env.LOCALAPPDATA ??
                join(homedir(), "AppData", "Local"))
              : join(homedir(), ".cache")),
        "simple-video",
      ),
  );
  const bin = platform() === "win32" ? "Scripts" : "bin";
  return {
    home: base,
    uv: join(base, "tools", platform() === "win32" ? "uv.exe" : "uv"),
    python: join(
      base,
      "depthflow",
      bin,
      platform() === "win32" ? "python.exe" : "python",
    ),
    depthflow: join(
      base,
      "depthflow",
      bin,
      platform() === "win32" ? "depthflow.exe" : "depthflow",
    ),
    workspace: join(base, "workspace"),
    huggingface: join(base, "huggingface"),
    torch: join(base, "torch"),
    models: join(base, "models"),
  };
}
export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
export function runtimeEnv() {
  const p = runtimePaths();
  return {
    UV_CACHE_DIR: join(p.home, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(p.home, "python"),
    UV_PYTHON_BIN_DIR: join(p.home, "python-bin"),
    UV_NO_MODIFY_PATH: "1",
    WORKSPACE: p.workspace,
    HF_HOME: p.huggingface,
    TORCH_HOME: p.torch,
  };
}
export function uvArtifact(os = platform(), cpu = arch()) {
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[`${os}-${cpu}`];
  const artifact = uvAssets.find(
    (a) => a.name === `uv-${target}.${os === "win32" ? "zip" : "tar.gz"}`,
  );
  if (!artifact)
    throw Error(
      `Unsupported bootstrap platform ${os}/${cpu}; provide --uv and a compatible Python/runtime. Linux requires glibc.`,
    );
  return artifact;
}
export function setupPlan(options: {
  uv?: string;
  python?: string;
  skipModel?: boolean;
}) {
  return {
    paths: runtimePaths(),
    uv: options.uv ?? { version: UV_VERSION, ...uvArtifact() },
    python: options.python ?? PYTHON_VERSION,
    packages: PYTHON_PACKAGES,
    modelDownload: !options.skipModel,
    model: "Depth Anything V2 Small (Hugging Face, local inference)",
    downloadSize:
      "May download several GB; size varies by platform and existing caches",
    graphics: "OpenGL 3.3+; checked separately with doctor --check-render",
    systemDependencies: [
      "ffmpeg with libx264",
      "ffprobe",
      "a working OpenGL driver",
    ],
    credentials: "No API keys required or copied",
    modifiesSystemPython: false,
  };
}
export async function bootstrapUv() {
  const p = runtimePaths(),
    artifact = uvArtifact();
  if (await exists(p.uv)) {
    const receipt = await readJson<{ sha256: string }>(
      join(p.home, "tools", "uv-receipt.json"),
    );
    const { fileHash } = await import("./io.js");
    if ((await fileHash(p.uv)) !== receipt.sha256)
      throw Error(
        "Managed uv binary changed; inspect or remove the tools folder before running setup again",
      );
    return p.uv;
  }
  const response = await fetch(artifact.url, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw Error(`uv download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha256:${hash(bytes)}` !== artifact.digest)
    throw Error("uv archive checksum does not match the pinned release");
  await mkdir(p.home, { recursive: true });
  const temporary = await mkdtemp(join(p.home, "uv-bootstrap-"));
  try {
    const archive = join(temporary, artifact.name);
    await writeFile(archive, bytes);
    await mkdir(join(p.home, "tools"), { recursive: true });
    // Windows ships bsdtar, which also reads zip archives. No shell interpolation.
    await command("tar", ["-xf", archive, "-C", temporary]);
    const { readdir, readFile } = await import("node:fs/promises");
    async function find(dir: string): Promise<string | undefined> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isFile() && e.name === (platform() === "win32" ? "uv.exe" : "uv"))
          return path;
        if (e.isDirectory()) {
          const found = await find(path);
          if (found) return found;
        }
      }
    }
    const binary = await find(temporary);
    if (!binary) throw Error("uv archive has no executable for this platform");
    const executable = await readFile(binary);
    await atomic(p.uv, executable);
    await chmod(p.uv, 0o700);
    await writeJson(join(p.home, "tools", "uv-receipt.json"), {
      version: UV_VERSION,
      source: artifact.url,
      archiveSha256: artifact.digest,
      sha256: hash(executable),
    });
    return p.uv;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function setup(options: {
  uv?: string;
  python?: string;
  skipModel?: boolean;
  dryRun?: boolean;
  approved?: boolean;
  log?: (event: unknown) => void;
}) {
  const plan = setupPlan(options);
  if (options.dryRun) return { ...plan, executed: false };
  if (!options.approved)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      2,
      `Setup needs your approval before downloading or installing anything. Run ${cliCommand("setup")} in a terminal to review and confirm, or add --yes for an unattended install. Use --dry-run to preview only.`,
      { plan, executed: false },
    );
  const p = runtimePaths();
  return withLock(join(p.home, "setup"), async () => {
    async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
      const started = Date.now();
      options.log?.({
        stage: "setup",
        step: name,
        status: "started",
        ...(name === "depthflow" ? { packages: PYTHON_PACKAGES } : {}),
      });
      const value = await action();
      options.log?.({
        stage: "setup",
        step: name,
        status: "complete",
        elapsedMs: Date.now() - started,
      });
      return value;
    }
    const uv = await step("uv", async () => {
      const binary = options.uv ?? (await bootstrapUv());
      await command(binary, ["--version"]);
      return binary;
    });
    const env = runtimeEnv();
    await step("python", async () => {
      if (await exists(p.python)) return;
      await command(
        uv,
        [
          "venv",
          "--managed-python",
          "--python",
          options.python ?? PYTHON_VERSION,
          join(p.home, "depthflow"),
        ],
        600_000,
        env,
      );
    });
    const exclude = join(p.home, "excluded-packages.txt");
    await atomic(exclude, "pyaudio\n");
    await step("depthflow", async () => {
      await command(
        uv,
        [
          "pip",
          "install",
          "--python",
          p.python,
          "--excludes",
          exclude,
          ...PYTHON_PACKAGES,
        ],
        1_200_000,
        env,
      );
      await command(
        p.python,
        ["-c", "import depthflow, torch; print('runtime imports OK')"],
        120_000,
        env,
      );
    });
    if (!options.skipModel) {
      await step("depth-model", async () => {
        const { prepareDepth } = await import("./depth.js");
        await prepareDepth(p.models);
      });
    }
    await writeJson(join(p.home, "setup.json"), {
      version: 1,
      at: new Date().toISOString(),
      python: await command(p.python, ["--version"]),
      packages: PYTHON_PACKAGES,
      modelPrepared: !options.skipModel,
    });
    return {
      ...plan,
      executed: true,
      next: cliCommand("doctor --check-render"),
    };
  });
}
export async function probeGraphics() {
  const p = runtimePaths();
  const binary = process.env.SIMPLE_VIDEO_DEPTHFLOW ?? p.depthflow;
  if (!(await exists(binary)))
    throw Error(`DepthFlow is missing. Run ${cliCommand("setup")}.`);
  const dir = await mkdtemp(join(tmpdir(), "simple-video-graphics-"));
  try {
    const image = join(dir, "image.png"),
      depth = join(dir, "depth.png"),
      output = join(dir, "probe.mp4");
    await sharp({
      create: { width: 180, height: 320, channels: 3, background: "#6388a5" },
    })
      .png()
      .toFile(image);
    await sharp({
      create: {
        width: 180,
        height: 320,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .greyscale()
      .png()
      .toFile(depth);
    await command(
      binary,
      [
        "horizontal",
        "-i",
        "0.105",
        "--linear",
        "--no-loop",
        "input",
        "-i",
        image,
        "-d",
        depth,
        "h264",
        "main",
        "--time",
        "0.5",
        "--fps",
        "24",
        "-w",
        "180",
        "-h",
        "320",
        "--ratio",
        "180:320",
        "--ssaa",
        "1",
        "--quality",
        "80",
        "--no-turbo",
        "-o",
        output,
      ],
      180_000,
      {
        ...runtimeEnv(),
        WINDOW_BACKEND: "headless",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
    );
    const metadata = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        output,
      ]),
    );
    if (
      !metadata.streams.some(
        (s: { codec_name: string }) => s.codec_name === "h264",
      )
    )
      throw Error("Graphics probe produced no H264 stream");
    return { ready: true, frames: 12, paidRequests: 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
