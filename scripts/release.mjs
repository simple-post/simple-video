import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Same convention as core's sdk-v*/cli-v*: stable -> latest, beta -> beta.
export function releaseMetadata(tag, pkg) {
  if (!/^video-v/.test(tag))
    throw Error("Release tags must start with video-v");
  const version = tag.slice("video-v".length);
  const number = "(?:0|[1-9]\\d*)";
  const identifier = "(?:0|[1-9]\\d*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)";
  const semver = new RegExp(
    `^${number}\\.${number}\\.${number}(?:-(${identifier}(?:\\.${identifier})*))?$`,
  );
  const match = version.match(semver);
  if (!match)
    throw Error("Release version must be SemVer without build metadata");
  if (version !== pkg.version)
    throw Error(
      `Tag version ${version} does not match package.json version ${pkg.version}`,
    );
  if (pkg.private) throw Error("package.json still has private: true");
  if (!/^@simple-post\/[a-z0-9][a-z0-9._-]*$/.test(pkg.name))
    throw Error("Expected a package in the @simple-post scope");
  if (
    pkg.publishConfig?.access !== "public" ||
    pkg.publishConfig?.registry !== "https://registry.npmjs.org"
  )
    throw Error("Publishing must target the public npm registry explicitly");
  if (
    pkg.repository?.url !==
    "git+https://github.com/simple-post/simple-video.git"
  )
    throw Error("repository.url must match the trusted-publisher repository");
  const prerelease = match[1];
  const channel = prerelease?.split(".")[0];
  const distTag =
    channel && /^[a-z][a-z0-9-]*$/.test(channel) && channel !== "latest"
      ? channel
      : prerelease
        ? "next"
        : "latest";
  return { name: pkg.name, version, distTag, tag };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const metadata = releaseMetadata(
      process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "",
      pkg,
    );
    console.log(JSON.stringify(metadata));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `name=${metadata.name}\nversion=${metadata.version}\ndist_tag=${metadata.distTag}\n`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
