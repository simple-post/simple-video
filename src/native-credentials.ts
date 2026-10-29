import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { dirname } from "node:path";
import { basename, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { CliError, hash } from "./io.js";
import { credentialsPath } from "./auth-file.js";

export interface NativeStore {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  delete(): Promise<boolean>;
}
export function nativeLabel(os: string = platform()) {
  return (
    (
      {
        darwin: "macOS Keychain",
        linux: "Linux Secret Service",
        win32: "Windows Credential Manager",
      } as Record<string, string>
    )[os] ?? "Unsupported OS credential store"
  );
}
export function nativeIdentity(directory = dirname(credentialsPath())) {
  // Canonicalize existing parents too, so a new /tmp config keeps its identity
  // after creation and when addressed later through /private/tmp on macOS.
  let parent = resolve(directory);
  const suffix: string[] = [];
  while (true) {
    try {
      directory = join(realpathSync(parent), ...suffix.reverse());
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(parent) === parent
      )
        throw error;
      suffix.push(basename(parent));
      parent = dirname(parent);
    }
  }
  return {
    service: "com.simple-post.video",
    account: `openai:${hash(platform() === "win32" ? directory.toLowerCase() : directory).slice(0, 32)}`,
  };
}
export function storeUnavailable() {
  const hint =
    platform() === "linux"
      ? "Start/unlock a Secret Service on your D-Bus session (such as GNOME Keyring or KWallet)."
      : platform() === "darwin"
        ? "Unlock your login keychain and allow access if macOS asks."
        : "Use an unlocked Windows user profile with Credential Manager access.";
  return new CliError(
    "AUTH_STORE_UNAVAILABLE",
    3,
    `${nativeLabel()} could not complete the operation. ${hint} The native binding must be installed. Choose --storage file or --storage env explicitly if needed; no fallback was used.`,
  );
}
export function nativeStore(
  options: {
    identity?: ReturnType<typeof nativeIdentity>;
    worker?: string;
    timeoutMs?: number;
  } = {},
): NativeStore {
  const identity = options.identity ?? nativeIdentity();
  async function request(
    operation: "get" | "set" | "delete",
    secret?: string,
  ): Promise<unknown> {
    if (!["darwin", "linux", "win32"].includes(platform()))
      throw storeUnavailable();
    // Isolate blocking native calls. Secrets use IPC, never command arguments,
    // environment variables, stdout or stderr. Even constructor hangs time out.
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      for (const name of [
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "FAL_KEY",
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
      ])
        delete env[name];
      const child = fork(
        options.worker ??
          fileURLToPath(new URL("./credential-worker.js", import.meta.url)),
        [],
        { env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      let settled = false;
      const finish = (ok: boolean, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (ok) resolve(value);
        else reject(storeUnavailable());
      };
      const timer = setTimeout(
        () => finish(false),
        options.timeoutMs ?? 30_000,
      );
      child.once("error", () => finish(false));
      child.once("exit", () => finish(false));
      child.once("message", (message: any) => {
        const valid =
          message?.ok === true &&
          (operation === "get"
            ? message.value === null || typeof message.value === "string"
            : operation === "delete"
              ? typeof message.value === "boolean"
              : message.value === undefined);
        finish(valid, message?.value);
      });
      child.send(
        { operation, identity, ...(secret === undefined ? {} : { secret }) },
        (error) => {
          if (error) finish(false);
        },
      );
    });
  }
  return {
    get: async () => (await request("get")) as string | null,
    set: async (key) => {
      await request("set", key);
    },
    delete: async () => (await request("delete")) as boolean,
  };
}
