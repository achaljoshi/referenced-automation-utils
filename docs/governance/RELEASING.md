# Releasing: versions, changelog, packaging and upgrading

## Versioning
Semantic versioning for every shared package (`utils`, `api`, `ui`, `sap`):
- **patch** - bug fixes, no change to exports, defaults or behaviour anyone relies on;
- **minor** - new exports or options, behaviour-compatible; deprecations are announced here;
- **major** - removed or changed exports, changed defaults or required settings, a raised Node or Playwright floor.

A change to `createPlaywrightConfig`, the logger format, the waiting behaviour or an env variable's meaning counts as public API, because it reaches every repo.

## Each release
1. Update `CHANGELOG.md` (Added / Changed / Fixed / Deprecated / Removed; say what is **not verified**).
2. Bump `version` in `package.json` (`npm version patch|minor|major --no-git-tag-version`). A published version is immutable, so every release is a new number.
3. `npm run lint && npm run typecheck && npm test && npm run security`.
4. Publish to the registry (`NPM_REGISTRY_URL` is the Artifactory npm registry URL): `./scripts/publish-package.sh --dry-run`, then `./scripts/publish-package.sh`. The script builds the package (`create-package.sh`: clean, build, `npm pack`) and runs `npm publish <tarball> --registry "$NPM_REGISTRY_URL"`; it does not log in for you. No script access? Run `./scripts/create-package.sh` and publish or deploy the `.tgz` it leaves in `../shared-packages/` yourself.
5. Tag the commit `v<version>`.

Publish in dependency order: `utils` -> `api` / `ui` -> `sap` -> consumers.

## Upgrading a consumer
Change the version in the consumer's `package.json` and install it - that is all:
```bash
# package.json: "@automation/referenced-automation-utils": "^1.1.0"      (was ^1.0.0)
npm install                                                 # fetches it from NPM_REGISTRY_URL, updates package-lock.json
npm ls playwright-core                                      # must show ONE version, deduped
npm run lint && npm run typecheck && npm test
git add package.json package-lock.json
```
Do not delete the lockfile and do not add `-D` for `@automation/*` packages. Upgrade **down the chain**: `utils` -> `api` / `ui` -> `sap` -> `ui-api`. Upgrading Playwright itself is its own procedure (README of `utils`, "Bumping Playwright").

## Trying a change before it is published
Local generation: `./scripts/setup.sh --local` in the consumer (sibling checkouts; PowerShell: `.\scripts\setup.bat --local`), or generate the tarballs with `./scripts/create-package.sh --local` and `npm install --no-save <the .tgz files>`. `package.json` and the lockfile stay untouched. See the README, "Using a package without a registry".

## The registry
The registry address is the `NPM_REGISTRY_URL` variable (never written into these repositories) and publishing needs an npm identity with deploy permission on it. How npm is authenticated against the Artifactory is the platform team's procedure and is deliberately **not** described in this repository; the scripts never log in. When the pipelines publish, it is a manual, protected job owned by the platform team.
