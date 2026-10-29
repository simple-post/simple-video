import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeStore,
  nativeLabel,
  nativeIdentity,
} from "../dist/native-credentials.js";
import {
  saveKey,
  savedKey,
  logout,
  credentialsPath,
  migrateFile,
} from "../dist/auth.js";
import { saveFileKey } from "../dist/auth-file.js";

// Opt-in integration test: touches only a fresh synthetic credential in the
// current user's native store, and deletes that exact credential in finally.
const directory = await mkdtemp(join(tmpdir(), "simple-video-native-auth-"));
const previous = process.env.SIMPLE_VIDEO_CONFIG_DIR;
process.env.SIMPLE_VIDEO_CONFIG_DIR = join(directory, "config");
const identity = nativeIdentity(),
  store = nativeStore();
let cleanup = false;
try {
  assert.equal(await store.get(), null);
  assert.equal(await store.delete(), false);
  const dummy = "sk-proj-synthetic-native-test-not-a-real-key-123456789";
  await saveKey(dummy, "keychain");
  assert.equal(await savedKey(), dummy);
  await assert.rejects(access(credentialsPath()));
  await saveKey(dummy + "-updated", "keychain");
  assert.equal(await savedKey(), dummy + "-updated");
  assert.equal((await logout()).removed, true);
  assert.equal(await store.get(), null);
  assert.equal((await logout()).removed, false);
  await saveFileKey(dummy);
  assert.equal((await migrateFile("keychain")).migrated, true);
  await assert.rejects(access(credentialsPath()));
  assert.equal(await savedKey(), dummy);
  await logout();
} finally {
  try {
    await store.delete();
    cleanup = true;
  } finally {
    if (previous === undefined) delete process.env.SIMPLE_VIDEO_CONFIG_DIR;
    else process.env.SIMPLE_VIDEO_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
    if (!cleanup)
      process.stderr.write(
        `Synthetic credential cleanup failed. Service/account: ${identity.service} / ${identity.account}\n`,
      );
  }
}
console.log(
  JSON.stringify({
    backend: nativeLabel(),
    createReadUpdateDelete: true,
    missingIsDistinctFromUnavailable: true,
    plaintextFile: false,
    cleanup,
    paidRequests: 0,
  }),
);
