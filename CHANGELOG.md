# Changelog

## Unreleased

### Added
- **Fortnightly framework audit**: `automation-framework-audit` (and `npm run audit` / `audit:quick`, `scripts/audit-family.sh|.bat`) runs deterministic checks with file:line evidence across one repo or the whole family, optionally runs each repo's gates, and writes `audit-reports/<date>/AUDIT_REPORT.md` + `audit.json` with a comparison to the previous audit; exceptions go in `.framework-audit.json` with a reason. `docs/governance/AUDIT.md`, `AUDIT_PROMPT.md` (the deeper judgement review), ADR 0011.
- **Logger** that reads correctly in a terminal and in a raw CI log: worker and correlation prefixes, no ANSI in CI, secrets redacted, tolerant file transport.
- **Correlation ids** (`getCorrelationId`, `withCorrelationId`, `useTestCorrelation`).
- **`Adapter` contract and `adapterStep`**; SMTP, SFTP and SQLite clients use them.
- **`testing`**: shared in-process SMTP and SFTP test servers.
- **`createPlaywrightConfig`**: one Playwright config for the family (browsers, devices, timeouts, reporters incl. JSON, log-in-once `auth`).
- **`mainframe`**: `Tn3270Session` over `s3270` (AID keys wait for the host, reads never stale, failures show the screen), a 3270 simulator and an s3270-protocol stand-in for tests.
- **Governance tools**: `automation-audit-gate` (exceptions that are owned, reasoned and expire), `automation-scan-secrets` (includes SAP recordings; never prints a secret), `automation-run-report` (failures, flaky and slowest tests, repeat offenders).
- Shared GitLab CI template with sharding and report merging (`ci/templates/`), ADRs 0001-0010, contributing/releasing guides.

- **`placeholders`**: `ScenarioVariables` and `{{name}}`, `{{env:X|fallback}}`, `{{uuid}}`, `{{random:email}}`, `{{date:+7d}}` placeholders for unique/fresh/env-driven test data (unresolvable ones fail loudly), shared by the UI and API frameworks.
- **`remote`: run steps on a remote desktop host over Remote Desktop** (`RemoteHost`, `RemoteDbClient`, `getRemoteHost` / `closeRemoteHost`, `remoteConfigFromEnv` with the `REMOTE_*` settings, `RdpSession`, the wire contract in `remote/protocol`). For tests that run on a Windows test machine (for example an AWS WorkSpace) while the DB, APIs and SAP GUI are reachable only from an RDP host with no other port open: requests travel as files through one redirected `subst` drive ("RDP drive mailbox") to a PowerShell agent (`agent/remote-agent.ps1`, shipped in the package) running inside the RDP session; HTTP, DB (`DbProviderFactories`), `exec` (off unless listed in `REMOTE_ALLOW`) and line-protocol helper processes (for the SAP bridge) are supported. `automation-remote` (`doctor`, `check`, `open`, `close`, `agent-dir`, `setup-help`), `docs/REMOTE_DESKTOP.md`, ADR 0012. The integrations in the `api` and `sap` packages follow in those repos. **NOT VERIFIED on a real Windows host:** the RDP launcher (`mstsc`/`cmdkey`/`subst`) and the PowerShell agent have never run on Windows; the TypeScript is tested against a stand-in agent and a recording command runner.

### Changed
- **Packages are installed by version from the npm registry**: `setup`/`create-package` run `npm config set registry "$NPM_REGISTRY_URL"` first; `scripts/publish-package.sh|.bat` (`--dry-run`) publishes the package tarball to that registry; `create-package --local [dir]` builds without it. README, `CROSS_REPO_GUIDE.md`, `RELEASING.md` and ADR 0010 (supersedes 0002) explain publishing to JFrog, upgrading by changing one version, and the local-generation / manual `npm install --no-save <tgz>` route.
- **Playwright 1.64.0** (was 1.62.1): the `@playwright/test` / `playwright-core` floor is `^1.64.0` and the peer range is `>=1.64.0 <2.0.0` where the package declares one; run `npx playwright install chromium` after upgrading.
- The shared config now also writes `test-results/results.json` (read by `automation-run-report`).

### Changed (behaviour)
These make a default stricter; each is a bug fix found by the 2026-10-10 framework audit, and this package is unpublished at 1.0.0.
- **`ConfigReader`** (SEC-04): `getBoolean` accepts `true/false/1/0/yes/no/on/off` (any case) and **throws** on anything else (it used to return false for `1`, `yes`, `ture`); `getInt` throws on `12abc`; `getList` drops empty entries; `toObject()` returns only the keys from the loaded `.env` files / explicit values, **not the whole of `process.env`**.
- **`validateSchema`** (ORC-04): schemas compile in strict mode, so an unknown keyword (`requried`) or format throws instead of being ignored; pass `{ strict: false }` for a schema you do not own. Compiled schemas are cached, and a schema with an `$id` can be compiled any number of times.
- **`SftpClient.rmdir`** (SEC-08) is **non-recursive by default** (`rmdir(dir, true)` to recurse); `healthCheck()` is false after a dropped connection; a second `connect()` ends the first connection.
- **`{{env:X}}`** (SEC-09) refuses `CI_JOB_TOKEN`, `CI_REGISTRY_PASSWORD`, `CI_DEPLOY_PASSWORD`, `CI_BUILD_TOKEN`, `CI_JOB_JWT*`, `CI_RUNNER_*TOKEN*`, `CI_DEPENDENCY_PROXY_PASSWORD` and `CI_REPOSITORY_URL`; `randomUtils.email()` / `{{random:email}}` produce `example.com|org|net` addresses, never a real provider.
- **`findEmailBySubject`** (UTL-02) returns the **newest** matching message (it returned the oldest) and marks it seen (`markSeen: false` to keep it unseen).
- **Logger redaction** (SEC-03) matches key names as words: `passed`, `bypass`, `passport` are no longer redacted; `jwt`, `session`, `bearer`, `private`, `apikey` variants are. There is no depth limit any more (cycles are cut instead), and message / error text is scrubbed of `Bearer ...`, JWTs, `scheme://user:pass@host` and `password=...`.
- **Secret scanner** (SEC-02): the placeholder test is anchored, so values merely starting with `true`, `null`, `<`, `example` are now reported; every tracked file is scanned even under `node_modules/` or `logs/`; new rules (JSON, unquoted YAML/properties/shell, `Authorization` headers, `curl -u`, JWTs, connection strings, Gherkin steps).
- **`automation-audit-gate`** (CI-05) fails closed on a report that is not `auditReportVersion` 2 with a matching `metadata.vulnerabilities.total` (exit 1), exits 2 when `npm audit` cannot be started, and rejects allowlist entries without `package`, with an empty/`UNASSIGNED` owner (unless `--allow-unassigned`; `npm run security` and this repo's pipeline pass it until GOV-01 names an owner) or expiring more than 366 days away (`--max-expiry-days`).
- **`automation-run-report`** (CI-05) exits 1 when the report has top-level `errors` or **no test executed** (`--min-executed N`, default 1; `0` allows an empty run), exits 2 for a bad number or an unknown option (`--fail-on-flaky=abc`), and skips corrupt history lines.
- **`createPlaywrightConfig`** (CI-02/SAP-01): `extraProjects` without a browser inherit the selected `BROWSER` project's `use`; new options `maxWorkers` and `fullyParallel`.
- **Shared CI template** (U14): the shard count is `parallel: N` (default 3) with `CI_NODE_INDEX/CI_NODE_TOTAL` - the `AUTOMATION_SHARDS` variable and the hand-written matrix are gone; the flake-history cache is keyed by the default branch and only its pipelines append; the security job only tolerates exit code 2 (`allow_failure: exit_codes: 2`); new `.automation-typecheck` job; the merge job gates on `--min-executed` / `--fail-on-flaky` (`AUTOMATION_MIN_EXECUTED`, `AUTOMATION_FAIL_ON_FLAKY`). `npm run lint` fails on any warning; the build job also runs `npm run typecheck`.
- **Mainframe** (UTL-04): after a command timeout the `s3270` process is stopped and the transport is finished (a late reply can no longer answer the next command); `waitForText`/`waitForNoText` use one overall deadline; `Wait(...)` commands get a longer transport limit than the wait itself; `S3270_PATH` and `TN3270_TIMEOUT_MS` are now read.
- **Correlation id** (UTL-03): `withCorrelationId` runs in an `AsyncLocalStorage` scope; `useTestCorrelation` restores the previous id.

### Fixed
- Type errors in test code that Playwright does not check (new `typecheck` script).
- `dateUtils.parseDate`/`parseDateTime` ignored their pattern unless another module had registered dayjs's `customParseFormat` plugin (UTL-01): `parseDate('03/04/2026', 'DD/MM/YYYY')` was 3 March.
- Excel rich-text cells read as `[object Object]`; formula cells with no cached result read as `undefined` (now `null`) (ORC-04).
- `parseCsv` kept a UTF-8 byte-order mark in the first header name (Excel's "CSV UTF-8").
- `crypto.mask(value, 0)` printed the whole value.
- `SftpClient`'s `healthCheck()` could not tell a dropped connection; the SFTP test server's `RMDIR` was recursive unlike a real server; `--append` failed when `.ci-history/` did not exist yet (empty CI cache).
- Docs: the governance README no longer says the registry is still to come and counts ADRs 0001-0010; `.secrets/` is git-ignored as ADR 0007 says; the mainframe comments no longer name environment variables nothing read.

### Added (hardening)
- `SftpClient` `hostFingerprint` / `hostVerifier` (SEC-08); `randomUtils.seed()` and `RANDOM_SEED` (seeded data, logged); `LOG_FILE_PER_WORKER`; `testing.startImapTestServer()` (an in-process IMAP server); `selectNewestMatch`, `findEmailBySubject` options `to`, `since`, `markSeen`; `ScenarioVariables` accepts a `ConfigReader`; `relativeDate(offset, pattern, from)`; the secret scan reports what it did not scan; `tests/lintRules.spec.ts` and `tests/docsConsistency.spec.ts` guard the lint rules and the documentation claims; ESLint `no-floating-promises`, `no-misused-promises` and the ADR 0005 ban on `waitForTimeout` / `networkidle` are configured.

### Not verified
- **The remote desktop feature on Windows**: `mstsc` with a redirected `subst` drive and `alternate shell`, `cmdkey` / `subst` output, and the whole of `agent/remote-agent.ps1` (never executed or parsed by PowerShell); behaviour on an AWS WorkSpace (nested RDP) and the real host's group policies. See `docs/REMOTE_DESKTOP.md` (Verified / NOT verified).
- `s3270` itself and a real 3270 host (the protocol is exercised against a stand-in process).
- The CI template on a real GitLab (structure only).
- Pipelines on the real GitLab.
- Publishing to the real JFrog registry (`publish-package` and registry-mode `npm ci` were exercised against a throwaway local npm registry; nothing was published; registry authentication is the platform team's).
