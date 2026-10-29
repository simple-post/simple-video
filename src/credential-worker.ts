// Native-binding boundary. Upstream errors can contain sensitive data: return
// only success/failure through IPC and never run a shell to transport a key.
process.once("message", async (message: any) => {
  let response: { ok: boolean; value?: unknown } = { ok: false };
  try {
    if (
      message?.identity?.service !== "com.simple-post.video" ||
      !/^openai:[a-f0-9]{32}$/.test(message.identity.account)
    )
      throw Error("Invalid identity");
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const entry = new AsyncEntry(
      message.identity.service,
      message.identity.account,
      { linux: { store: "secret-service" } },
    );
    if (message.operation === "get")
      response = { ok: true, value: await entry.getPassword() };
    else if (
      message.operation === "set" &&
      typeof message.secret === "string"
    ) {
      await entry.setPassword(message.secret);
      response = { ok: true };
    } else if (message.operation === "delete")
      response = { ok: true, value: await entry.deletePassword() };
  } catch {
    /* Locked, unavailable and ambiguous stores all fail closed. */
  }
  process.send?.(response, () => process.exit(0));
});
