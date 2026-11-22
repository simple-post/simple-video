import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { CliError, cliCommand } from "./io.js";

export function credentialsPath(
  directory = process.env.SIMPLE_VIDEO_CONFIG_DIR,
) {
  const base =
    directory ??
    join(
      platform() === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : platform() === "win32"
          ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
          : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")),
      "simple-video",
    );
  return join(resolve(base), "credentials.json");
}

export async function inspect(path: string, directory = false) {
  const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw new CliError(
      "AUTH_CONFIG_ERROR",
      3,
      "Could not access the Simple Video credential store. Check its permissions.",
    );
  });
  if (
    stat &&
    (stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (platform() !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
  )
    throw new CliError(
      "AUTH_CONFIG_UNSAFE",
      3,
      `Credential ${directory ? "directory" : "file"} must belong to you, must not be a symlink, and must be private. Check ${path} (${directory ? "0700" : "0600"} permissions on Unix).`,
    );
  return stat;
}

export function validateKey(value: string) {
  const key = value.trim();
  if (!/^sk-[A-Za-z0-9_-]{16,1000}$/.test(key))
    throw new CliError(
      "INVALID_INPUT",
      2,
      "Expected an OpenAI API key beginning with sk-, with no spaces or extra text. Nothing was saved.",
    );
  return key;
}

export async function fileKey() {
  const file = credentialsPath();
  const { dirname } = await import("node:path");
  await inspect(dirname(file), true);
  if (!(await inspect(file))) return undefined;
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (stat.size > 8192) throw Error("Invalid store");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value.version !== 1 || typeof value.OPENAI_API_KEY !== "string")
      throw Error("Invalid store");
    return validateKey(value.OPENAI_API_KEY);
  } catch {
    throw new CliError(
      "AUTH_CONFIG_ERROR",
      3,
      `Saved credentials are unreadable or invalid. Run ${cliCommand("auth login")} to replace them, or auth logout to remove them.`,
    );
  } finally {
    await handle.close();
  }
}

export async function saveFileKey(value: string) {
  const key = validateKey(value),
    file = credentialsPath(),
    { dirname } = await import("node:path"),
    dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await inspect(dir, true);
  await inspect(file);
  const temporary = join(dir, `.credentials-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ version: 1, OPENAI_API_KEY: key }) + "\n",
      );
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    saved: true,
    storage: "local-file",
    path: file,
    encrypted: false,
    validatedWithProvider: false,
  };
}

export async function deleteFileKey() {
  const file = credentialsPath(),
    { dirname } = await import("node:path");
  await inspect(dirname(file), true);
  const found = await inspect(file);
  if (found) await unlink(file);
  return {
    removed: Boolean(found),
    path: file,
    note: "Environment variables and env files are unchanged.",
  };
}

export async function keyFromStdin(
  input: NodeJS.ReadableStream = process.stdin,
) {
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    if (text.length > 8192)
      throw new CliError(
        "INVALID_INPUT",
        2,
        "API-key input is too long. Nothing was saved.",
      );
  }
  return validateKey(text);
}
