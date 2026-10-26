import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function atomic(file: string, data: string | Buffer) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}
export const writeJson = (file: string, value: unknown) =>
  atomic(file, `${JSON.stringify(value, null, 2)}\n`);
export function safeId(value: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value))
    throw new Error(
      "Run ID must use lowercase letters, numbers, underscores or hyphens (max 80 characters)",
    );
  return value;
}
export function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/fal_sk_[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\d{6,12}:[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .slice(0, 1000);
}
export async function fileHash(file: string) {
  return hash(await readFile(file));
}
export async function withLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const path = resolve(root, "writer.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = await readJson<{ pid: number }>(path).catch(() => null);
    if (!owner || !Number.isInteger(owner.pid))
      throw new Error("Unreadable writer lock; inspect it before removing it");
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        await unlink(path);
        return withLock(root, action);
      }
      throw e;
    }
    throw new Error(`Another CLI writer is active (PID ${owner.pid})`);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.close();
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}
export async function command(
  binary: string,
  args: string[],
  timeoutMs = 180_000,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout = (stdout + String(b)).slice(-1_000_000);
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + String(b)).slice(-8000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${binary} exited ${code}: ${stderr}`));
    });
  });
}
