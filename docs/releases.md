# npm releases

Package: **`@simple-post/video`**. Executable: **`simple-video`**. Repository: `simple-post/simple-video`.

The process mirrors [`simple-post/core`](https://github.com/simple-post/core/blob/main/.github/workflows/release.yml): a release tag triggers GitHub Actions, the tag must match `package.json`, checks/tests run, and npm publishes using its GitHub OIDC trusted publisher. No long-lived npm token is stored in GitHub.

## One-time bootstrap

A maintainer must create the package with its first publication before its package Settings are available:

```sh
npm login --scope=@simple-post --auth-type=web
npm ci
npm version 0.1.0-rc.0 --no-git-tag-version
npm run release:check
# Commit the candidate metadata before publishing; do not push a release tag yet.
git add package.json package-lock.json
git commit -m "Prepare video 0.1.0 release candidate"
git push origin main
npm publish --access public --tag rc
```

Use your own authenticated npm account with publishing access to the `simple-post` organization. Complete any browser/2FA step yourself; do not paste tokens into issues, shell commands or GitHub secrets. The one-time bootstrap uses `0.1.0-rc.0` under the `rc` dist-tag. After configuring trusted publishing below, promote to stable `0.1.0` and let the real release workflow publish it. This verifies OIDC without dummy versions or storing an npm token in GitHub.

After the first publication, configure the trusted publisher using npm's supported CLI (complete any npm browser/passkey prompt):

```sh
npm trust github @simple-post/video \
  --repo=simple-post/simple-video --file=release.yml --allow-publish --yes
npm trust list @simple-post/video --json
```

The equivalent npm Settings → Trusted publishing fields are:

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Organization/user | `simple-post`                                                          |
| Repository        | `simple-video`                                                         |
| Workflow filename | `release.yml`                                                          |
| Environment       | Leave empty (the workflow does not use an environment)                 |
| Allowed actions   | Enable direct `npm publish`; leave stage publishing as provided by npm |

Once the publisher is configured, commit/push the stable version and release it through CI:

```sh
npm version 0.1.0 --no-git-tag-version
npm run release:check
git add package.json package-lock.json
git commit -m "Release video 0.1.0"
git push origin main
git tag video-v0.1.0
git push origin video-v0.1.0
```

New publisher configurations must complete a successful publish within npm's activation window (currently two days). Validate it with the next real, authorized release; do not invent a version just to test authentication. If it expires, recreate the configuration before the next release.

Keep the GitHub repository private unless a visibility change is explicitly requested. A public npm package can be published from a private repository, but npm provenance attestations are not generated for private repositories. Do not force `--provenance` while the repo remains private. [npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

1. Make and review changes. Update the changelog.
2. Bump the version without creating npm's default `v*` tag:

   ```sh
   npm version patch --no-git-tag-version
   npm run release:check
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "Release video 0.1.1"
   git push origin main
   ```

3. Create and push the matching release tag:

   ```sh
   git tag "video-v$(node -p 'require("./package.json").version')"
   git push origin "video-v$(node -p 'require("./package.json").version')"
   ```

4. Inspect the **Release to npm** workflow. It validates metadata, ensures the tagged commit belongs to main, runs type/format/tests, checks the package allowlist, builds a tarball and publishes that exact tarball. The public registry is queried after publication with bounded retries for npm processing/propagation, and its integrity must match the tested tarball. Verification never repeats the publication.
5. Verify installation from npm in a fresh directory and update examples/docs when behavior changes. A version on main is not proof that it has shipped.

The runtime `--version` reads `package.json`, so it follows the published version automatically. Tags are immutable release identifiers. Never force-move a release tag or overwrite an npm version; fix forward with a new version if a published artifact is wrong.

## Prereleases

```sh
npm version 0.2.0-beta.1 --no-git-tag-version
# Commit version/changelog, push main, then:
git tag video-v0.2.0-beta.1
git push origin video-v0.2.0-beta.1
```

| Tag                   | npm dist-tag |
| --------------------- | ------------ |
| `video-v0.1.0`        | `latest`     |
| `video-v0.2.0-beta.1` | `beta`       |
| `video-v0.2.0-rc.0`   | `rc`         |
| `video-v0.2.0-0`      | `next`       |

Numeric or unsupported prerelease channels fall back to `next`. A prerelease named `latest` also falls back to `next`. Malformed versions and tag/package mismatches fail before publication. Build metadata in release versions is not supported.

Install a prerelease with `npm install -g @simple-post/video@beta`.

## Failure recovery

- **Tag/version mismatch:** correct the package version before creating a new release tag. Do not edit a published tag.
- **ENEEDAUTH/E404 during CI publish:** check the exact package, GitHub repository and `release.yml` trusted-publisher fields, allowed direct-publish action and activation expiry. `npm whoami` cannot validate OIDC publishing permissions.
- **2FA prompt during the first local publication:** complete npm's browser/OTP flow; CI releases use OIDC after configuration.
- **Version already exists:** inspect the registry's artifact/integrity first. Never assume a failed post-publish verification means the publish itself failed. Re-run installation/verification without publishing again, or release a new version after a real code change.
- **Packaging check fails:** repair missing CLI/skill/docs files or remove private/media/runtime files; rebuild before publishing. `npm pack` alone does not prove the executable works.
- **npm 12.0.0 provenance error:** the workflow deliberately pins npm 11.16.0, matching core's known working publishing setup. Change this pin only after testing the replacement.
