import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  chmod,
  symlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  credentialsPath,
  saveKey,
  savedKey,
  loadSavedKey,
  logout,
  keyFromStdin,
  selection,
  configureStorage,
  keyStatus,
  migrateFile,
  settingsPath,
} from "../src/auth.js";
import { saveFileKey } from "../src/auth-file.js";
import { nativeStore, type NativeStore } from "../src/native-credentials.js";
import { askText } from "../src/terminal.js";

const fakeKey = "sk-proj-test-only-not-a-real-key-1234567890";
const exec = promisify(execFile),
  bin = fileURLToPath(new URL("../../bin/run.js", import.meta.url));

test("credential store is private, environment wins, logout removes only the saved key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-auth-")),
    oldDir = process.env.SIMPLE_VIDEO_CONFIG_DIR,
    oldKey = process.env.OPENAI_API_KEY;
  try {
    process.env.SIMPLE_VIDEO_CONFIG_DIR = join(dir, "config");
    delete process.env.OPENAI_API_KEY;
    assert.equal(await savedKey(), undefined);
    await assert.rejects(access(join(dir, "config")));
    const result = await saveKey(fakeKey, "file");
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
    assert.equal(await savedKey(), fakeKey);
    if (process.platform !== "win32") {
      assert.equal((await stat(credentialsPath())).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, "config"))).mode & 0o777, 0o700);
    }
    await loadSavedKey();
    assert.equal(process.env.OPENAI_API_KEY, fakeKey);
    process.env.OPENAI_API_KEY = "sk-existing-environment-value-1234567890";
    await loadSavedKey();
    assert.notEqual(process.env.OPENAI_API_KEY, fakeKey);
    assert.equal((await logout()).removed, true);
    assert.equal((await logout()).removed, false);
    assert.equal(
      process.env.OPENAI_API_KEY,
      "sk-existing-environment-value-1234567890",
    );
    await assert.rejects(access(credentialsPath()));
  } finally {
    if (oldDir === undefined) delete process.env.SIMPLE_VIDEO_CONFIG_DIR;
    else process.env.SIMPLE_VIDEO_CONFIG_DIR = oldDir;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "credential writes reject invalid keys before touching disk and reject symlinks/unsafe stores",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "simple-video-auth-safety-")),
      old = process.env.SIMPLE_VIDEO_CONFIG_DIR;
    try {
      process.env.SIMPLE_VIDEO_CONFIG_DIR = join(dir, "config");
      await assert.rejects(saveKey("not a key", "file"), /Nothing was saved/);
      await assert.rejects(access(join(dir, "config")));
      await saveKey(fakeKey, "file");
      await chmod(credentialsPath(), 0o644);
      await assert.rejects(savedKey(), /must be private/);
      await assert.rejects(saveKey(fakeKey, "file"), /must be private/);
      await chmod(credentialsPath(), 0o600);
      await writeFile(credentialsPath(), "broken store", { mode: 0o600 });
      await assert.rejects(savedKey(), /unreadable or invalid/);
      await logout();
      const target = join(dir, "target");
      await writeFile(target, "untouched", { mode: 0o600 });
      await symlink(target, credentialsPath());
      await assert.rejects(savedKey(), /symlink/);
      await assert.rejects(saveKey(fakeKey, "file"), /symlink/);
      assert.equal(await readFile(target, "utf8"), "untouched");
    } finally {
      if (old === undefined) delete process.env.SIMPLE_VIDEO_CONFIG_DIR;
      else process.env.SIMPLE_VIDEO_CONFIG_DIR = old;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("hidden entry does not echo the key and closed input cancels", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let displayed = "";
  output.on("data", (bytes) => {
    displayed += bytes.toString();
  });
  const answer = askText("Key: ", true, input, output);
  input.write(fakeKey + "\n");
  assert.equal(await answer, fakeKey);
  assert.equal(displayed.includes(fakeKey), false);
  assert.match(displayed, /Key:/);
  input.destroy();
  output.destroy();
  const closed = new PassThrough(),
    cancelled = askText("Prompt: ", false, closed, new PassThrough());
  closed.end();
  await assert.rejects(cancelled, /Cancelled/);
  const stream = new PassThrough(),
    parsed = keyFromStdin(stream);
  stream.end(fakeKey + "\n");
  assert.equal(await parsed, fakeKey);
});

test("CLI login via stdin/env works across projects and never prints the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-auth-cli-")),
    config = join(dir, "config");
  const env = {
    ...process.env,
    OPENAI_API_KEY: "",
    SIMPLE_VIDEO_CONFIG_DIR: config,
  };
  const invoke = (args: string[], extra = {}) =>
    exec(process.execPath, [bin, "--json", "--no-input", ...args], {
      env: { ...env, ...extra },
    });
  try {
    await assert.rejects(
      invoke(["auth", "login", "--storage", "file"]),
      (e: unknown) => {
        const error = e as { stderr: string };
        assert.equal(JSON.parse(error.stderr).error.code, "INPUT_REQUIRED");
        return true;
      },
    );
    await assert.rejects(access(config));
    const child = spawn(
      process.execPath,
      [
        bin,
        "--json",
        "--no-input",
        "auth",
        "login",
        "--storage",
        "file",
        "--stdin",
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes.toString();
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes.toString();
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(fakeKey + "\n");
    assert.equal(await done, 0);
    assert.equal(JSON.parse(stdout).command, "auth login");
    assert.equal((stdout + stderr).includes(fakeKey), false);
    const status = JSON.parse(
      (
        await invoke([
          "--project",
          join(dir, "other-project"),
          "auth",
          "status",
        ])
      ).stdout,
    );
    assert.equal(status.data.configured, true);
    assert.equal(status.data.source, "saved credentials");
    const fromEnv = await invoke(["auth", "login", "--from-env"], {
      OPENAI_API_KEY: fakeKey,
    });
    assert.equal(fromEnv.stdout.includes(fakeKey), false);
    const file = join(dir, "provided.env");
    await writeFile(file, `OPENAI_API_KEY=${fakeKey}\n`, { mode: 0o600 });
    const explicit = JSON.parse(
      (await invoke(["--env-file", file, "auth", "status"])).stdout,
    );
    assert.equal(explicit.data.source, "environment or --env-file");
    const deleted = JSON.parse((await invoke(["auth", "logout"])).stdout);
    assert.equal(deleted.data.removed, true);
    assert.equal(
      JSON.parse((await invoke(["auth", "status"])).stdout).data.configured,
      false,
    );
    assert.match(await readFile(file, "utf8"), /OPENAI_API_KEY=/);
    await assert.rejects(invoke(["auth", "login", "--from-env", "--stdin"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native migration verifies the destination, preserves the source on failure, and never falls back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-migration-")),
    old = process.env.SIMPLE_VIDEO_CONFIG_DIR;
  let value: string | null = null,
    failRead = true;
  const native: NativeStore = {
    get: async () => (failRead ? "wrong-value" : value),
    set: async (key) => {
      value = key;
    },
    delete: async () => {
      value = null;
      return true;
    },
  };
  try {
    process.env.SIMPLE_VIDEO_CONFIG_DIR = join(dir, "config");
    await saveFileKey(fakeKey); // Version 0.2.0 file, with no chosen backend.
    const original = await readFile(credentialsPath(), "utf8");
    assert.equal((await keyStatus()).legacyFilePresent, true);
    await assert.rejects(savedKey(native), /legacy/);
    await assert.rejects(migrateFile("keychain", native), /could not complete/);
    assert.equal(await readFile(credentialsPath(), "utf8"), original);
    assert.equal(await selection(), undefined);
    failRead = false;
    const result = await migrateFile("keychain", native);
    assert.equal(result.migrated, true);
    assert.equal(result.otherFilePresent, false);
    assert.equal(await savedKey(native), fakeKey);
    await assert.rejects(access(credentialsPath()));
    assert.equal(
      (await readFile(settingsPath(), "utf8")).includes(fakeKey),
      false,
    );
    const unavailable: NativeStore = {
      get: async () => {
        throw Error("locked");
      },
      set: async () => {
        throw Error("locked");
      },
      delete: async () => {
        throw Error("locked");
      },
    };
    await assert.rejects(saveKey(fakeKey, "keychain", unavailable), /locked/);
    await assert.rejects(savedKey(unavailable), /locked/);
    await assert.rejects(logout("keychain", unavailable), /locked/);
    await assert.rejects(access(credentialsPath()));
    assert.equal(await selection(), "keychain");
    await configureStorage("env");
    assert.equal(await savedKey(unavailable), undefined);
    await assert.rejects(saveKey(fakeKey, "env", native), /never saves/);
  } finally {
    if (old === undefined) delete process.env.SIMPLE_VIDEO_CONFIG_DIR;
    else process.env.SIMPLE_VIDEO_CONFIG_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("native worker transport hides keys from argv/env/errors and bounds hung native calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-worker-"));
  try {
    const safe = join(dir, "safe.cjs"),
      bad = join(dir, "bad.cjs"),
      hung = join(dir, "hung.cjs");
    await writeFile(
      safe,
      `process.once('message', m => { const ok = m.operation === 'set' && typeof m.secret === 'string' && !process.argv.join(' ').includes(m.secret) && !process.env.OPENAI_API_KEY; process.send({ok},()=>process.exit(0)); });`,
    );
    await nativeStore({ worker: safe, timeoutMs: 2000 }).set(fakeKey);
    await writeFile(
      bad,
      `process.once('message', m => { process.stderr.write(m.secret || ''); process.send({ok:false,error:m.secret},()=>process.exit(0)); });`,
    );
    await assert.rejects(
      nativeStore({ worker: bad, timeoutMs: 2000 }).set(fakeKey),
      (e: unknown) => {
        assert.equal(String(e).includes(fakeKey), false);
        assert.match(String(e), /no fallback/);
        return true;
      },
    );
    await writeFile(hung, `setInterval(()=>{},1000);`);
    const start = Date.now();
    await assert.rejects(
      nativeStore({ worker: hung, timeoutMs: 100 }).get(),
      /could not complete/,
    );
    assert.ok(Date.now() - start < 5000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a migration excludes concurrent login, logout and preference changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-auth-race-")),
    old = process.env.SIMPLE_VIDEO_CONFIG_DIR;
  let release!: () => void,
    started!: () => void,
    value: string | null = null;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const native: NativeStore = {
    set: async (key) => {
      value = key;
      started();
      await gate;
    },
    get: async () => value,
    delete: async () => true,
  };
  try {
    process.env.SIMPLE_VIDEO_CONFIG_DIR = join(dir, "config");
    await saveKey(fakeKey, "file");
    const migration = migrateFile("keychain", native);
    await entered;
    try {
      await assert.rejects(logout("file", native), /Another CLI writer/);
      await assert.rejects(
        saveKey(fakeKey + "-new", "file", native),
        /Another CLI writer/,
      );
      await assert.rejects(configureStorage("env"), /Another CLI writer/);
      assert.equal(await selection(), "file");
    } finally {
      release();
    }
    await migration;
    assert.equal(await savedKey(native), fakeKey);
    await assert.rejects(access(credentialsPath()));
  } finally {
    release();
    if (old === undefined) delete process.env.SIMPLE_VIDEO_CONFIG_DIR;
    else process.env.SIMPLE_VIDEO_CONFIG_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup and auth expose storage choices without downloading or silently saving keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-video-storage-cli-")),
    config = join(dir, "config");
  const env = {
    ...process.env,
    OPENAI_API_KEY: "",
    SIMPLE_VIDEO_CONFIG_DIR: config,
  };
  const invoke = (args: string[]) =>
    exec(process.execPath, [bin, "--json", "--no-input", ...args], { env });
  try {
    const preview = JSON.parse(
      (await invoke(["setup", "--dry-run", "--auth-only", "--storage", "env"]))
        .stdout,
    );
    assert.equal(preview.data.authentication.selected, "env");
    assert.equal(preview.data.authentication.choices.length, 3);
    await assert.rejects(access(config));
    await assert.rejects(invoke(["setup", "--auth-only"]), (e: unknown) => {
      assert.equal(
        JSON.parse((e as { stderr: string }).stderr).error.code,
        "STORAGE_SELECTION_REQUIRED",
      );
      return true;
    });
    await invoke(["setup", "--auth-only", "--storage", "env"]);
    const pref = JSON.parse(
      await readFile(join(config, "authentication.json"), "utf8"),
    );
    assert.equal(pref.storage, "env");
    await assert.rejects(access(join(config, "credentials.json")));
    const status = JSON.parse((await invoke(["auth", "status"])).stdout);
    assert.equal(status.data.configured, false);
    assert.equal(status.data.storage, "env");
    await assert.rejects(
      invoke(["auth", "login", "--storage", "env", "--from-env"]),
    );
    await invoke(["auth", "login", "--storage", "env"]);
    await assert.rejects(access(join(config, "credentials.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
