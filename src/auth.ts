import { dirname, join } from "node:path";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { CliError, withLock } from "./io.js";
import {
  credentialsPath,
  inspect,
  fileKey,
  saveFileKey,
  deleteFileKey,
  validateKey,
} from "./auth-file.js";
import {
  nativeStore,
  nativeIdentity,
  nativeLabel,
  storeUnavailable,
  type NativeStore,
} from "./native-credentials.js";
export { credentialsPath, validateKey, keyFromStdin } from "./auth-file.js";
export type Storage = "keychain" | "file" | "env";
export const settingsPath = () =>
  join(dirname(credentialsPath()), "authentication.json");
export function storage(value: string): Storage {
  if (!["keychain", "file", "env"].includes(value))
    throw new CliError(
      "INVALID_INPUT",
      2,
      "Storage must be keychain, file or env.",
    );
  return value as Storage;
}
export function storageInfo(value: Storage) {
  return value === "keychain"
    ? {
        storage: value,
        label: nativeLabel(),
        ...nativeIdentity(),
        protection: "OS-managed",
      }
    : value === "file"
      ? {
          storage: value,
          label: "Private local file (unencrypted)",
          path: credentialsPath(),
          encrypted: false,
        }
      : { storage: value, label: "Environment variable only (no saved key)" };
}
export function storageChoices() {
  return (["keychain", "file", "env"] as const)
    .filter(
      (s) =>
        s !== "keychain" || ["darwin", "linux", "win32"].includes(platform()),
    )
    .map((s) => ({ ...storageInfo(s), recommended: s === "keychain" }));
}
export async function selection(): Promise<Storage | undefined> {
  const file = settingsPath();
  await inspect(dirname(file), true);
  if (!(await inspect(file))) return undefined;
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if ((await handle.stat()).size > 8192) throw Error("Invalid settings");
    const data = JSON.parse(await handle.readFile("utf8"));
    if (data.version !== 1) throw Error("Invalid version");
    return storage(data.storage);
  } catch {
    throw new CliError(
      "AUTH_CONFIG_ERROR",
      3,
      "Authentication preferences are invalid. Inspect authentication.json before continuing.",
    );
  } finally {
    await handle.close();
  }
}
async function writeSelection(value: Storage) {
  const file = settingsPath(),
    dir = dirname(file),
    temp = join(dir, `.auth-${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await inspect(dir, true);
  await inspect(file);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ version: 1, storage: value }) + "\n",
      );
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function configureStorage(value: Storage) {
  const chosen = storage(value);
  await authLock(() => writeSelection(chosen));
  return {
    selected: true,
    ...storageInfo(value),
    otherFilePresent: value !== "file" && (await legacyFilePresent()),
    note: "Only the storage preference was saved. Existing keys in other stores are unchanged.",
  };
}
async function authLock<T>(action: () => Promise<T>) {
  const dir = dirname(credentialsPath());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await inspect(dir, true);
  return withLock(join(dir, "auth-lock"), action);
}
export async function legacyFilePresent() {
  await inspect(dirname(credentialsPath()), true);
  // Presence checks must not read a key or fail after saving to a different store.
  return lstat(credentialsPath()).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return false;
      throw new CliError(
        "AUTH_CONFIG_ERROR",
        3,
        "Could not inspect the existing credential file.",
      );
    },
  );
}
export async function authPlan(value?: Storage) {
  return {
    selected: value ?? (await selection()) ?? null,
    choices: storageChoices(),
    settingsPath: settingsPath(),
  };
}
export async function savedKey(native: NativeStore = nativeStore()) {
  const chosen = await selection();
  if (chosen === "env") return undefined;
  if (!chosen) {
    if (await legacyFilePresent())
      throw new CliError(
        "STORAGE_SELECTION_REQUIRED",
        2,
        "A legacy file-based key exists. Choose storage with auth login; use --storage keychain --migrate-file to move it after verification.",
      );
    return undefined;
  }
  if (chosen === "file") return fileKey();
  const key = await native.get();
  return key === null ? undefined : validateKey(key);
}
export async function saveKey(
  value: string,
  chosen?: Storage,
  native: NativeStore = nativeStore(),
) {
  const key = validateKey(value),
    target = chosen ?? (await selection());
  if (!target)
    throw new CliError(
      "STORAGE_SELECTION_REQUIRED",
      2,
      "Choose --storage keychain or --storage file before saving a key.",
    );
  if (target === "env")
    throw new CliError(
      "INVALID_INPUT",
      2,
      "Environment mode never saves a key. Set OPENAI_API_KEY in your environment or use --env-file.",
    );
  return authLock(() => saveUnlocked(key, target, native));
}
async function saveUnlocked(
  key: string,
  target: "file" | "keychain",
  native: NativeStore,
) {
  if (target === "file") await saveFileKey(key);
  else {
    await native.set(key);
    if ((await native.get()) !== key) throw storeUnavailable();
  }
  await writeSelection(target);
  return {
    saved: true,
    ...storageInfo(target),
    otherFilePresent: target === "keychain" && (await legacyFilePresent()),
    validatedWithProvider: false,
  };
}
export async function migrateFile(
  chosen: Storage,
  native: NativeStore = nativeStore(),
) {
  if (chosen !== "keychain")
    throw new CliError(
      "INVALID_INPUT",
      2,
      "--migrate-file requires --storage keychain.",
    );
  return authLock(async () => {
    const key = await fileKey();
    if (!key)
      throw new CliError(
        "SETUP_REQUIRED",
        3,
        "There is no file-based key to migrate.",
      );
    const result = await saveUnlocked(key, chosen, native);
    // Keep the original if the destination cannot be read back exactly.
    try {
      await deleteFileKey();
    } catch {
      throw new CliError(
        "AUTH_MIGRATION_INCOMPLETE",
        3,
        "The OS store was verified, but the original key file could not be removed. It still exists; inspect it or use auth logout --storage file.",
      );
    }
    return {
      ...result,
      migrated: true,
      otherFilePresent: false,
      removedFile: credentialsPath(),
    };
  });
}
export async function logout(
  chosen?: Storage,
  native: NativeStore = nativeStore(),
) {
  const target = chosen ?? (await selection());
  if (!target)
    return {
      removed: false,
      note: "No storage selected. Use --storage file to remove a legacy file, or --storage keychain for the OS store.",
    };
  return authLock(async () => {
    const removed =
      target === "env"
        ? false
        : target === "file"
          ? (await deleteFileKey()).removed
          : await native.delete();
    return {
      removed,
      ...storageInfo(target),
      note: "Environment variables, external env files and other storage backends are unchanged.",
    };
  });
}
export async function keyStatus(envFile?: string) {
  const chosen = await selection();
  const otherFilePresent = chosen !== "file" && (await legacyFilePresent());
  if (process.env.OPENAI_API_KEY)
    return {
      configured: true,
      source: envFile ? "environment or --env-file" : "environment",
      selectedStorage: chosen ?? null,
      otherFilePresent,
      validatedWithProvider: false,
    };
  if (!chosen)
    return {
      configured: false,
      source: "none",
      storage: "unselected",
      legacyFilePresent: await legacyFilePresent(),
      validatedWithProvider: false,
    };
  return {
    configured: Boolean(await savedKey()),
    source:
      chosen === "keychain"
        ? nativeLabel()
        : chosen === "file"
          ? "saved credentials"
          : "environment",
    ...storageInfo(chosen),
    otherFilePresent,
    validatedWithProvider: false,
  };
}
export async function loadSavedKey() {
  if (!process.env.OPENAI_API_KEY) {
    const key = await savedKey();
    if (key) process.env.OPENAI_API_KEY = key;
  }
}
