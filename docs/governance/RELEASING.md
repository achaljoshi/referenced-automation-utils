# Releasing: versions, changelog, packaging and upgrading

## Versioning
Semantic versioning for every shared package (`utils`, `api`, `ui`, `sap`):
- **patch** - bug fixes, no change to exports, defaults or behaviour anyone relies on;
- **minor** - new exports or options, behaviour-compatible; deprecations are announced here;
- **major** - removed or changed exports, changed defaults or required settings, a raised Node or Playwright floor.

A change to `createPlaywrightConfig`, the logger format, the waiting behaviour or an env variable's meaning counts as public API, because it reaches every repo.

## Each release
1. Update `CHANGELOG.md` (Added / Changed / Fixed / Deprecated / Removed; say what is **not verified**).
2. Bump `version` in `package.json`.
3. `npm run lint && npm run typecheck && npm test && npm run security`.
4. Package: `./scripts/create-package.sh` writes the tarball to `../shared-packages/`.
5. Tag the commit `v<version>`.

## Upgrading a consumer
```bash
npm install ../shared-packages/<package>-<version>.tgz     # keep the lockfile; do not delete it; do not add -D for @automation/* packages
npm ls playwright-core                                      # must show ONE version, deduped
npm run lint && npm run typecheck && npm test
```
Repackage and reinstall **up the chain**: `utils` -> `api` / `ui` -> `sap` -> `ui-api`. Upgrading Playwright itself is its own procedure (README of `utils`, "Bumping Playwright").

## The registry (not done, and not done by these repos)
The target is an internal npm registry with these same versions. Setting it up needs the platform team, and the registry address and credentials are CI/CD variables (`NPM_REGISTRY_URL`). **Nothing in these repositories publishes to a registry**, and this document deliberately contains no registry or login commands; when the registry exists, publishing becomes a manual, protected pipeline job owned by the platform team and the consumer's `file:` dependency becomes a version range.
