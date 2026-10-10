# Changelog

## Unreleased

### Added
- **Logger** that reads correctly in a terminal and in a raw CI log: worker and correlation prefixes, no ANSI in CI, secrets redacted, tolerant file transport.
- **Correlation ids** (`getCorrelationId`, `withCorrelationId`, `useTestCorrelation`).
- **`Adapter` contract and `adapterStep`**; SMTP, SFTP and SQLite clients use them.
- **`testing`**: shared in-process SMTP and SFTP test servers.
- **`createPlaywrightConfig`**: one Playwright config for the family (browsers, devices, timeouts, reporters incl. JSON, log-in-once `auth`).
- **`mainframe`**: `Tn3270Session` over `s3270` (AID keys wait for the host, reads never stale, failures show the screen), a 3270 simulator and an s3270-protocol stand-in for tests.
- **Governance tools**: `automation-audit-gate` (exceptions that are owned, reasoned and expire), `automation-scan-secrets` (includes SAP recordings; never prints a secret), `automation-run-report` (failures, flaky and slowest tests, repeat offenders).
- Shared GitLab CI template with sharding and report merging (`ci/templates/`), ADRs 0001-0009, contributing/releasing guides.

- **`placeholders`**: `ScenarioVariables` and `{{name}}`, `{{env:X|fallback}}`, `{{uuid}}`, `{{random:email}}`, `{{date:+7d}}` placeholders for unique/fresh/env-driven test data (unresolvable ones fail loudly), shared by the UI and API frameworks.

### Changed
- **Packages are installed by version from the npm registry**: `setup`/`create-package` run `npm config set registry "$NPM_REGISTRY_URL"` first; `scripts/publish-package.sh|.bat` (`--dry-run`) publishes the package tarball to that registry; `create-package --local [dir]` builds without it. README, `CROSS_REPO_GUIDE.md`, `RELEASING.md` and ADR 0010 (supersedes 0002) explain publishing to JFrog, upgrading by changing one version, and the local-generation / manual `npm install --no-save <tgz>` route.
- **Playwright 1.64.0** (was 1.62.1): the `@playwright/test` / `playwright-core` floor is `^1.64.0` and the peer range is `>=1.64.0 <2.0.0` where the package declares one; run `npx playwright install chromium` after upgrading.
- The shared config now also writes `test-results/results.json` (read by `automation-run-report`).

### Fixed
- Type errors in test code that Playwright does not check (new `typecheck` script).

### Not verified
- `s3270` itself and a real 3270 host (the protocol is exercised against a stand-in process).
- The CI template on a real GitLab (structure only).
- Pipelines on the real GitLab.
- Publishing to the real JFrog registry (`publish-package` and registry-mode `npm ci` were exercised against a throwaway local npm registry; nothing was published; registry authentication is the platform team's).
