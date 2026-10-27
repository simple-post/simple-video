import { pathToFileURL } from "node:url";

export async function verifyPublished(name, version, integrity, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 20;
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "Cache-Control": "no-cache" },
      });
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    if (response?.ok) {
      const pkg = await response.json();
      if (
        pkg.name !== name ||
        pkg.version !== version ||
        pkg.bin?.["simple-video"] !== "bin/run.js"
      )
        throw Error(
          "Published package name, version or CLI entry does not match the release",
        );
      if (integrity && pkg.dist?.integrity !== integrity)
        throw Error("Registry integrity does not match the tested npm tarball");
      return { name, version, integrity: pkg.dist?.integrity, verified: true };
    }
    if (response && response.status !== 404 && response.status < 500)
      throw Error(`Registry verification HTTP ${response.status}`);
    if (attempt < attempts) {
      if (options.log)
        options.log(
          `Waiting for npm processing/registry propagation (${attempt}/${attempts})`,
        );
      await wait(15_000);
    }
  }
  throw Error(
    "The package is not visible in the registry yet. Inspect npm processing status; do not repeat publication automatically.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [name, version, integrity] = process.argv.slice(2);
    if (!name || !version)
      throw Error(
        "Usage: node scripts/verify-published.mjs PACKAGE VERSION [INTEGRITY]",
      );
    console.log(
      JSON.stringify(
        await verifyPublished(name, version, integrity, { log: console.error }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
