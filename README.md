# referenced-automation-utils

Shared, framework-agnostic TypeScript utilities reused by every other `referenced-automation-*` repo (`ui`, `api`, `ui-api`, `sap`): environment config, logging, crypto, date, random test data, JSON/YAML/CSV/Excel, JSON Schema validation, dot/bracket object-path traversal, DB access, email/SMTP, and SFTP file transfer.

Nothing in here depends on Playwright or a browser - it is pure Node/TypeScript, so it is equally useful to the UI framework, the API framework, and anything else.

**New to this repo family?** See [CROSS_REPO_GUIDE.md](./CROSS_REPO_GUIDE.md) for the full picture: how the five repos share code, how to build/package/consume across them, environment setup, fixtures, overriding behavior, and a new-joiner checklist. This README covers only what's specific to `utils` itself.

## Quick start

```bash
./scripts/setup.sh      # npm ci (scripts/setup.bat on Windows)
npm test                # runs this package's own unit tests
```

`setup.sh`/`setup.bat` run `npm ci`. They first run `npm config set registry "$NPM_REGISTRY_URL"` when that variable is set, so every package is fetched from your organisation's npm registry (see [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory)). This package has no `@automation/*` dependencies of its own.

## What's included

| Module | What it's for |
|---|---|
| `config/env` | `loadEnv()` - loads `.env.<ENV>` based on the `ENV` variable, typed `get`/`getInt`/`getBoolean`/`getList` accessors - strict: `getBoolean` takes true/false/1/0/yes/no/on/off and `getInt` a whole number, anything else throws; `toObject()` returns only the keys from your `.env` files, never the rest of the process environment. See [Environments](#environments). |
| `logger/logger` | Console + `logs/automation.log` logging (winston), plus `loggedStep()` to wrap any action with start/pass/fail logging. Reads correctly in a terminal **and** a raw CI log - see [Logging](#logging-local-and-ci). |
| `logger/correlation` | A per-test correlation ID (`getCorrelationId`, `withCorrelationId` - AsyncLocalStorage-scoped, so overlapping calls do not clobber each other - `useTestCorrelation`) stamped on every log line and sent as `X-Correlation-Id` by the API client, so one failing flow can be grepped across the console, the API gateway and SAP. |
| `adapters` (`Adapter`, `adapterStep`, `AdapterError`) | The contract every outside system (SMTP, SFTP, SQLite, SAP GUI) follows: a `name`, `healthCheck()`, `close()`, and every operation logged with timing and failures wrapped as `AdapterError('[sftp] upload failed: ...')`. Write a new client against it and it behaves like the rest. |
| `mainframe` (`Tn3270Session`) | A 3270 terminal session over `s3270` (the scriptable emulator from the x3270 suite), with the waiting a hand-written script forgets: every Enter/PF key waits for the host to answer, reads are never of the previous screen, and a failure shows the screen as it was. See [Mainframe (3270)](#mainframe-3270). |
| `testing` | In-process SMTP, IMAP and SFTP servers for tests (`testing.startSmtpTestServer()`, `testing.startImapTestServer()`, `testing.startSftpTestServer()`), shared by every repo instead of copied into each. |
| `placeholders` (`ScenarioVariables`, `randomValue`, `relativeDate`) | `{{name}}`, `{{env:X\|fallback}}`, `{{uuid}}`, `{{random:email}}`, `{{date:+7d}}` placeholders for unique/fresh/env-driven test data; fails loudly when one cannot be resolved; `{{env:X}}` refuses the credentials a CI system injects (`CI_JOB_TOKEN`, `CI_REGISTRY_PASSWORD`, `CI_JOB_JWT*`, ...) and `{{random:email}}` only uses reserved example domains. See [Placeholders](#placeholders-for-test-data). |
| `playwright/config` (`createPlaywrightConfig`) | One Playwright config for the whole family: `BROWSER`/`DEVICE`/timeouts/reporters from `.env.<name>`, optional log-in-once `auth` project. Each repo's `playwright.config.ts` is now ~5 lines. See [Shared Playwright config](#shared-playwright-config). |
| `crypto` | md5/sha1/sha256/sha512, hmac, base64, and `mask()` for logging sensitive values safely. |
| `dateUtils` | Thin `dayjs`-based helpers: format/parse, add days/months/hours/minutes, diff, compare, epoch conversion. |
| `randomUtils` | `@faker-js/faker`-backed test data: names, emails, addresses, UUIDs, bounded random numbers, past/future dates, credit card numbers. |
| `jsonUtils` / `yamlUtils` | Parse/stringify/read-from-file, plus `readAt()` for path-based reads on raw JSON text. |
| `csvUtils` / `excelUtils` | Read/write CSV and `.xlsx` as arrays of row objects - the shape data-driven tests want. |
| `validation` (`getPath`/`setPath`/`hasPath`/`requirePath`) | Dot/bracket path traversal over any object, e.g. `getPath(response, 'data.users[0].name')`. This is what the API framework's response wrapper is built on. |
| `validation` (`validateSchema`) | JSON Schema (draft-07/2019/2020) validation via `ajv`, with a ready-to-assert `errorsText`. Compiled schemas are cached (a schema with an `$id` can be used by any number of tests) and strict: a misspelt keyword (`requried`) or format throws instead of passing everything; `{ strict: false }` for a schema you do not own. |
| `db` (`DbClient`, `SqliteClient`) | A driver-agnostic query/update contract; implement it once per real DB engine your project needs. `SqliteClient` is a ready-to-use reference implementation. |
| `emailUtils` | One-off `sendEmail()` (nodemailer) and `findEmailBySubject()` to search an inbox (imapflow) - for OTP/verification-email assertions: the NEWEST unseen match wins, `to` / `since` pick out your own message when tests share a mailbox, and the message is marked seen afterwards (`markSeen: false` keeps it). Tested against an in-process IMAP server (`testing.startImapTestServer`). |
| `SmtpClient` | A reusable SMTP connection for sending several emails without reconnecting each time - `connect once, send many, close`, unlike `emailUtils.sendEmail()`'s one-shot connection. |
| `SftpClient` | A pure Node.js SFTP client (connect/upload/download/list/exists/delete/mkdir/rmdir) - the same job WinSCP does interactively, but scriptable and identical on Windows, macOS/Linux, and GitLab CI's Linux runners, with no WinSCP install required anywhere. |

## Logging (local and CI)

`getLogger('component')` returns the shared winston logger. Output is built to be read in two places:

```
2026-10-07 03:01:35.019 [info] [w2] [cid:ad9e928b] [sap-gui] set text ... {"id":"wnd[0]/tbar[0]/okcd","value":"/nVA01"}
2026-10-07 03:01:35.123 [info] [w2] [cid:ad9e928b] [sap-gui] set text ok (104ms)
```

- **One stream, stdout.** Lines are never split across stdout/stderr, so their order survives in a CI job log.
- **Colour only in a real terminal.** Off when `CI` or `NO_COLOR` is set, so GitLab logs contain no escape codes; `FORCE_COLOR=1` turns it back on.
- **`[w2]` is the Playwright worker, `[cid:ad9e928b]` the test's correlation ID.** With parallel workers, interleaved lines are unreadable without them. `grep ad9e928b` follows one test everywhere.
- **Secrets are redacted** before anything is written: any value, at any depth, under a key that names a secret - matched as whole words (`password`, `token`, `authorization`, `secret`, `api key`, `cookie`, `credential`, `jwt`, `session`, `bearer`, `private`), so `passed`, `bypass` and `passport` are kept. Free text is scrubbed too: `Bearer <token>`, `Authorization:` headers, JWTs, `scheme://user:pass@host` and `password=...` in a message or an error. A cyclic object is cut, not followed.
- **Errors are readable**: ANSI codes from Playwright's messages are stripped, multi-line messages stay multi-line.
- **A file as well** (`logs/automation.log`, JSON lines - a CI artifact). If it can't be created (read-only checkout) the logger carries on with the console rather than failing the run.

`LOG_LEVEL` (default `info`), `LOG_TO_FILE=false`, `LOG_FILE=<path>`, `LOG_FILE_PER_WORKER=true` (one rotated file per Playwright worker, `automation-w2.log`, instead of every worker appending to one), `NO_COLOR=1`, `FORCE_COLOR=1`. `tests/logger.spec.ts` asserts all of this against a real child process's output.

## Adapters

Anything that talks to a system outside the test process implements `Adapter` and wraps each operation in `adapterStep`:

```ts
async upload(local: string, remote: string) {
  return adapterStep(this, 'upload', async () => { /* ... */ }, { details: { remote } });
}
```

That one wrapper gives every client the same behaviour: `[sftp] upload ... {"remote":"/in/a.csv"}` then `[sftp] upload ok (84ms)`, and on failure an `AdapterError('[sftp] upload failed: <reason>')` carrying the original as `cause`. `SmtpClient`, `SftpClient`, `SqliteClient` and the SAP GUI session (in `referenced-automation-sap`) all use it.

## Mainframe (3270)

```ts
import { mainframe } from '@automation/referenced-automation-utils';

const transport = new mainframe.S3270Transport();   // needs the x3270 suite's s3270 on the PATH, or at $S3270_PATH (or pass { command })
const term = await mainframe.Tn3270Session.connect(transport, { host: env.get('MAINFRAME_HOST'), port: 23 });

await term.fillAfterLabel('USERID', env.get('MF_USER'));                    // finds the label, types in the field after it
await term.fillAfterLabel('PASSWORD', env.get('MF_PASSWORD'), { secret: true });   // never logged
await term.enter();                                                          // returns once the host has answered
await term.waitForText('MAIN MENU');                                         // on timeout the error shows the screen as it was
await term.fillAfterLabel('ACCOUNT NUMBER', '123456');
await term.enter();
const balance = await term.waitForText(/BALANCE\s+([\d,.]+ GBP)/);
await term.pf(3);
await term.close();
```

Why it is built this way: a 3270 host answers asynchronously and the screen **keeps showing the old content** until it does - the classic way a script misreads a screen or types into one that is still locked. So AID keys (Enter, PF, PA, Clear) wait for the keyboard to unlock, `screen()` always reads after that wait, and `waitForText` polls. Rows and columns in this API are 1-based (as on a screen); the emulator's are 0-based and converted for you.

`mainframe.createSampleMainframe()` is an in-memory host (logon, menu, account inquiry; the keyboard locks after Enter and the old screen is shown until the host "answers"), so scripts can be tried and the session logic tested with no mainframe. It proves the session logic, **not** that a script matches your host.

**Verified here** (no mainframe and no `s3270` on the build machine): the session logic against the simulator, including a negative control that shows a read straight after Enter returns the *previous* screen; and the `s3270` line protocol (a command per line in; `data:` lines, a status line and `ok`/`error` out) against a stand-in process that speaks it - sequential commands, error replies, timeouts, a crashed emulator. **Not verified:** a real `s3270` and a real host. The command syntax (`Connect(L:host:port)`, `Wait(seconds,Unlock)`, `MoveCursor(row,col)` 0-based, `Ascii`) and the 12-field status line were written from the x3270 scripting documentation and have not been run against the real program - install `s3270`, point `S3270_PATH` at it and try the logon above first. Batch/JES submission is not covered (use the SFTP/FTP client for file-based job interfaces).

## Test servers

```ts
import { testing } from '@automation/referenced-automation-utils';
const server = await testing.startSmtpTestServer();   // ... testing.stopSmtpTestServer(server)
```

`testing.startSftpTestServer()` is the same for SFTP. They load `smtp-server`/`ssh2` lazily, so a project that never calls them never loads either.

## Shared Playwright config

```ts
// playwright.config.ts
import { createPlaywrightConfig } from '@automation/referenced-automation-utils';
export default createPlaywrightConfig({ dir: __dirname, name: '@automation/my-project', baseUrlKey: 'BASE_URL' });
```

Everything else comes from `.env.<name>` or the environment (`BROWSER`, `DEVICE`, `HEADLESS`, `WORKERS`, `RETRIES`, `TEST_TIMEOUT_MS`, ...; the full list is in the function's doc comment). An unknown `BROWSER` fails immediately with the valid names instead of silently running chromium. Log in once and reuse it everywhere with `auth: { setupMatch: /auth\.setup\.ts/, storageState: AUTH_FILE }` - see `referenced-automation-ui-api` for a working example.

Options worth knowing: `extraProjects` that do not choose a browser themselves (a BDD project) **inherit the selected `BROWSER`/`DEVICE` project's `use`**, so a firefox CI leg runs them in firefox, the browser it installed; `maxWorkers: 1` caps `WORKERS` for suites that share one stateful system (SAP) so no variable can start a second worker; `fullyParallel: false` turns off in-file parallelism. Boolean and integer variables are strict - `HEADLESS=ture` or `RETRIES=2x` fails at start-up instead of silently meaning something else.

## Placeholders for test data

`placeholders.ScenarioVariables` is a scenario's named values plus `{{...}}` placeholders, for data that must be unique, fresh or environment-driven instead of hard-coded: `{{name}}` (a saved value), `{{env:NAME|fallback}}`, `{{uuid}}`, `{{timestamp}}`, `{{random:email}}` / `alnum(8)` / `number(1,100)`, `{{date:+7d}}` / `{{date:-1M|DD/MM/YYYY}}`. An unresolvable placeholder throws and names what is known - it is never sent to a system as literal text. The UI and API packages use it for their Gherkin steps and test fixtures (`vars`); it has nothing to do with BDD itself and works in any test.

## No waits in tests

Playwright already waits inside every action and web-first assertion, so a fixed sleep is either too short (flaky) or too long (slow). The family enforces this rather than hoping:

- `ui`'s state reads (`isVisible`, `isEnabled`, `isChecked`, `count`, `allText`) **wait** up to the expect timeout; pass `{ timeout: 0 }` only to read the state *right now* (asserting something is **not** there).
- ESLint **errors** on `waitForTimeout` and on `'networkidle'` in `utils` (`tests/lintRules.spec.ts` proves the rule fires), `ui`, `sap` and `ui-api`, and on a floating or misused promise (`no-floating-promises`, `no-misused-promises`: a missing `await` turns an assertion into one that cannot fail). `npm run lint` fails on any warning, and CI also runs `npm run typecheck`.
- `ui/tests/noWaits.spec.ts` proves it against a page that renders late.
- The SAP GUI half has the same property by construction: every step waits for SAP to be idle and the element to exist.

## Bumping Playwright

All five repos must resolve **one** `playwright-core` (two copies mean two sets of browser revisions and confusing "executable doesn't exist" errors). The policy: a caret floor in `package.json` plus the lockfile for the exact version, and a direct `playwright-core` devDependency so npm dedupes it.

1. In each repo set `@playwright/test` **and** `playwright-core` to the new `^x.y.z` (and the peer range in `ui`/`api`/`sap`).
2. `npm install` - **keep the lockfile**. Deleting `package-lock.json` makes every version float.
3. `npx playwright install chromium` (browsers are per Playwright version).
4. `npm ls playwright-core` must show one version, `deduped` everywhere.

## Dependency audit gate

`npx automation-audit-gate` runs `npm audit` and fails (exit 1) on any advisory at or above `--level` (default `high`) that is not covered by an **explicit, owned, expiring** entry in `audit-allowlist.json`:

```json
{ "allow": [ { "id": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "why this is acceptable", "owner": "team or person", "expires": "2027-03-31" } ] }
```

An exception stops protecting you on its expiry date, so an accepted risk has to be re-decided on purpose rather than forgotten; entries that match nothing any more are reported (`--strict-allowlist` fails on them), and an exception inside 30 days of expiry warns. Every entry needs `package`, a real `owner` (empty or `UNASSIGNED` is an error unless you pass `--allow-unassigned`) and an expiry no more than a year away (`--max-expiry-days` changes the limit). Exit codes: **1** the gate failed - a blocking advisory, an allowlist that breaks those rules, or an audit report the tool does not understand (it requires `auditReportVersion` 2 and a `metadata.vulnerabilities.total` that matches, and fails closed otherwise); **2** the audit could not run (offline, no registry, `npm` missing). The shared CI template lets only exit code 2 fail without blocking.

**Currently accepted here:** `@faker-js/faker` GHSA-qxc2-j82w-r537 (high). The fix is v10.5+, which is ESM-only, and this family compiles to CommonJS on Node >=18, so it needs an ESM migration. Nothing in the family's own code calls `faker.helpers.fake()`, but `randomUtils` re-exports the whole faker API, so a project must not pass untrusted input to it. The entry has **no owner yet** (so `npm run security` and the pipeline pass `--allow-unassigned` for now) and expires 2027-03-31 - name an owner in `audit-allowlist.json` and drop the flag.

## Secret scan

`npx automation-scan-secrets` (also in `npm run security` and the pipeline's `security` job) fails when a secret is about to be committed: private keys, cloud/CI tokens, **JWTs**, `Authorization: Bearer|Basic` headers (including `curl -H`) and `curl -u`, passwords in URLs and **connection strings**, literal passwords assigned in code, **JSON** `"password": "..."` values, **unquoted** YAML / properties / shell / Dockerfile values, secrets typed into **Gherkin steps**, committed `.env` secrets and SAP recordings. Placeholders (`${VAR}`, `<token>`, `{{env:X}}`, `changeme`, `true`, `null`, ...) are skipped by an *anchored* test: a real secret that merely starts with `true...` or `null...` is still found. It never prints a secret - every occurrence in a line is masked, whichever rule found it. Every tracked file is scanned even under `node_modules/` or `logs/` (a committed secret is in the history); only *untracked* files in generated directories are left out, and the summary counts what was not scanned (generated, binary, over 1 MB, unreadable). Intentional exceptions go in `.secretscan-allow.json`, with a reason.

## Run report and test gates

`npx automation-run-report --input test-results/results.json --out report.md` summarises a run (failures, flaky tests, slowest tests, repeat offenders across `--history`) and gates it: `--min-executed N` (default 1: an empty or all-skipped run is not a pass; `0` allows it), `--fail-on-flaky N`, and it always fails when the report carries top-level errors (a failed global setup). A corrupt history line is skipped and counted; numeric options are validated and an unknown option is an error, so a typo cannot switch a gate off. Exit codes: 0 ok, 1 a gate failed, 2 unreadable report or bad command line.

## Environments

Every consuming repo follows the same pattern: `.env.<name>` files at the repo root (committed, no secrets), an optional `.env.<name>.local` (gitignored, for real credentials), selected at runtime by the `ENV` variable:

```bash
ENV=qa npx playwright test      # loads .env.qa
ENV=stage npx playwright test   # loads .env.stage
```

A `playwright.config.ts` only has to do this once, and every test/fixture that needs config imports the same reader instead of touching `process.env` directly:

```ts
import { loadEnv } from '@automation/referenced-automation-utils';

const env = loadEnv(); // ENV var, defaulting to "qa"
export default defineConfig({
  use: { baseURL: env.get('BASE_URL') },
});
```

See `.env.qa` / `.env.stage` / `.env.dev` in this repo for the pattern, and `.env.example` for what's safe to commit vs. what belongs in a gitignored `.local` file.

### Where connection details actually live

This repo never holds a real host, username, password, connection string, or API key for anything - not for the DB client, not for email/SMTP, not for SFTP. Every client here takes connection details as a parameter (`DbClient`'s constructor, `SmtpConfig`, `SftpConfig`); this package only ships the *shape* and the logic that uses it, never a value. That's deliberate, not an oversight: this package is imported by every other repo in the family, so anything committed here would leak into all of them and would need to be identical across every environment they each run against - neither is true or safe.

The real values belong in whichever repo actually calls the client, read the same way as `BASE_URL`/`API_BASE_URL` already are - from that repo's own `.env.<name>` file via `loadEnv()`:

```ts
// inside referenced-automation-api (or ui, sap, ui-api) - not inside utils
import { loadEnv, SftpClient } from '@automation/referenced-automation-utils';

const env = loadEnv();
const sftp = new SftpClient();
await sftp.connect({
  host: env.get('SFTP_HOST'),
  username: env.get('SFTP_USER'),
  password: env.get('SFTP_PASSWORD'), // from .env.<name>.local or a CI secret, never committed
});
```

This keeps `utils` genuinely generic and safe to depend on from anywhere, and keeps every real secret exactly where it's used and rotated - one repo's staging DB password never has to live somewhere four other repos can see it.

## SMTP and SFTP - connecting for real

Both `SmtpClient` and `SftpClient` are thin wrappers with a `connect`/`use`/`close` lifecycle (`SmtpClient` uses nodemailer's pooled transport instead of an explicit `connect()`, since nodemailer manages that internally) - config always comes from the caller, per [Where connection details actually live](#where-connection-details-actually-live) above.

```ts
import { loadEnv, SmtpClient } from '@automation/referenced-automation-utils';

const env = loadEnv();
const smtp = new SmtpClient({
  host: env.get('SMTP_HOST'),
  port: env.getInt('SMTP_PORT'),
  secure: env.getBoolean('SMTP_SECURE'),
  auth: { user: env.get('SMTP_USER'), pass: env.get('SMTP_PASS') },
});

await smtp.verify(); // confirms the connection/credentials without sending anything
await smtp.send({ from: 'qa@example.com', to: 'user@example.com', subject: 'Welcome', text: 'Hi!' });
await smtp.send({ from: 'qa@example.com', to: 'user2@example.com', subject: 'Welcome', text: 'Hi!' });
smtp.close(); // once done sending - the same connection served both sends above
```

```ts
import { loadEnv, SftpClient } from '@automation/referenced-automation-utils';

const env = loadEnv();
const sftp = new SftpClient();
await sftp.connect({
  host: env.get('SFTP_HOST'),
  username: env.get('SFTP_USER'),
  password: env.get('SFTP_PASSWORD'),
});

await sftp.upload('./report.csv', '/incoming/report.csv');
const files = await sftp.list('/incoming');
console.log(files.map((f) => f.name));
await sftp.delete('/incoming/old-report.csv');
await sftp.close();
```

**Host key.** Pin the server's key so a man in the middle cannot collect the password: `connect({ ..., hostFingerprint: 'SHA256:...' })` (the form `ssh-keygen -lf` prints; 64 hex characters also work) or a `hostVerifier(hostKey: Buffer) => boolean` of your own - the connection is refused before credentials are sent. Without either, `connect` logs a warning that the host is not verified. `rmdir()` removes empty directories only; `rmdir(dir, true)` deletes recursively, on purpose. `healthCheck()` is false once the server or network drops the connection, and a second `connect()` ends the first connection instead of leaking it.

`SftpClient` deliberately isn't a wrapper around the real `winscp.com` executable - that would only work on a machine with WinSCP already installed (fine for a Windows RDP box, but not for macOS/Linux dev machines or a GitLab CI Linux runner). It's a pure Node.js SFTP implementation instead, so the same test runs identically everywhere this framework runs. `tests/support/sftpTestServer.ts` and `tests/support/smtpTestServer.ts` are real, minimal, in-process SFTP/SMTP servers - not stubs - used to test both clients against actual protocol traffic; see `tests/sftpClient.spec.ts` / `tests/smtpClient.spec.ts` for the full working examples.

## Publishing a package to the registry (JFrog Artifactory)

The other repos install `@automation/referenced-automation-utils` **by version** from your organisation's npm registry, so each new version has to be published there. In order:

1. **Know the registry URL.** It is the npm registry URL of your Artifactory - the one in your `~/.npmrc` and in the `NPM_REGISTRY_URL` CI/CD variable. This repo never hard-codes it; ask your platform team if you do not have it.
2. **Be allowed to publish.** Publishing needs an npm identity with deploy permission on that repository. How you authenticate npm against your Artifactory is your organisation's own procedure and is not covered here - the scripts in this repo never log in for you.
3. **Choose the version and record it.** A version can be published only once:
   ```bash
   npm version patch --no-git-tag-version      # or minor / major - changes package.json only
   ```
   Add the change to `CHANGELOG.md` and commit both.
4. **Point the scripts at the registry** (once per terminal):
   ```bash
   export NPM_REGISTRY_URL="<your registry URL>"        # Windows cmd: set NPM_REGISTRY_URL=<your registry URL>
   ```
5. **Publish** - a dry run first:
   ```bash
   ./scripts/publish-package.sh --dry-run     # builds the package and lists what would be uploaded
   ./scripts/publish-package.sh               # uploads it            (Windows: scripts\publish-package.bat)
   ```
   The script runs `npm config set registry "$NPM_REGISTRY_URL"`, builds with `create-package.sh` (clean, build, `npm pack`) and runs `npm publish <the .tgz> --registry "$NPM_REGISTRY_URL"`.
6. **Check it arrived:** `npm view @automation/referenced-automation-utils versions --registry "$NPM_REGISTRY_URL"` lists the new version.

**Without the script.** `./scripts/create-package.sh` leaves `../shared-packages/automation-referenced-automation-utils-<version>.tgz`, the exact file `npm publish` uploads. Publish that file yourself (`npm publish ../shared-packages/<file>.tgz --registry "$NPM_REGISTRY_URL"`), or deploy the `.tgz` into the npm repository through the Artifactory web UI (the repository's **Deploy** action - Artifactory takes the package name and version from the tarball; check with your platform team how your repository is set up), or hand it to whoever manages the repository.

**Order matters.** Publish what a package depends on first: `utils` -> `api` and `ui` -> `sap` -> the consuming repos.

## First rollout: publish, then install from the registry

To see the whole chain work from the registry (no `--local`): set `NPM_REGISTRY_URL`, publish `utils`, `api`, `ui`, `sap` **in that order** (`./scripts/publish-package.sh --dry-run`, then without `--dry-run`, in each repo; the first publish uses the current version, 1.0.0), confirm with `npm view @automation/referenced-automation-<name> versions --registry "$NPM_REGISTRY_URL"`, then in a consumer run `rm -rf node_modules && ./scripts/setup.sh` and check `npm ls @automation/referenced-automation-utils` and the `resolved` address in `package-lock.json`. The full walkthrough is [section 4.3 of the cross-repo guide](https://github.com/achaljoshi/referenced-automation-utils/blob/master/CROSS_REPO_GUIDE.md#43-first-rollout-publish-everything-then-install-from-the-registry).

## Using a package without a registry (local generation)

Use this when the packages are not in a registry yet, or you want to try a change before publishing it. Nothing in `package.json` or the lockfile changes.

**Automatic - when the repos are checked out next to each other:**

```bash
./scripts/create-package.sh          # Windows: scripts\create-package.bat
```

It builds this package (clean, build, `npm pack`) and writes `../shared-packages/automation-referenced-automation-utils-<version>.tgz`.

**Manual - generating a tarball and placing it yourself** (for example when the consuming repo is on another machine):

1. Generate the tarball:
   ```bash
   ./scripts/create-package.sh --local
   ```
   The file is named `automation-referenced-automation-utils-<version>.tgz` after the version in `package.json` and lands in `../shared-packages`.
2. Leave the files in `../shared-packages`, or copy them into the consuming repo (any folder works, for example `libs/` - keep it out of git).
3. Install them, all in one command (change the folder if you copied the files elsewhere):
   ```bash
   npm install --no-save ../shared-packages/automation-referenced-automation-utils-<version>.tgz
   ```
   `--no-save` keeps `package.json` and the lockfile unchanged. Run it again after every `npm ci`, because `npm ci` removes what is not in the lockfile. When you rebuild a tarball with the same version, run the command again to pick up the new contents.
4. Build and test as usual (`npm run build`, `npm test`).

When you are done experimenting, run `npm ci` to go back to what the registry provides.

## IDE setup

- **VS Code**: opening this repo prompts to install the recommended extensions (`.vscode/extensions.json`) - Playwright Test, ESLint, Prettier. Format-on-save and ESLint auto-fix are pre-wired in `.vscode/settings.json`.
- **IntelliJ / WebStorm**: `.idea/` ships ESLint and Prettier turned on automatically, plus run configurations for `npm: test` and `npm: build`. Node.js/TypeScript/Playwright support is bundled with WebStorm and IntelliJ Ultimate - no plugin install needed.

## Project layout

```
referenced-automation-utils/
├── src/                    # SHIPPED in the package (see package.json "files")
│   ├── config/env.ts
│   ├── logger/logger.ts
│   ├── crypto/cryptoUtils.ts
│   ├── date/dateUtils.ts
│   ├── random/randomUtils.ts
│   ├── data/{jsonUtils,yamlUtils,csvUtils,excelUtils}.ts
│   ├── validation/{objectPath,schemaValidator}.ts
│   ├── db/{dbClient,sqliteClient}.ts
│   ├── email/emailUtils.ts
│   └── index.ts             # barrel export - this is what `import ... from '@automation/referenced-automation-utils'` resolves to
├── tests/                  # this package's own unit tests, NOT shipped
├── scripts/{setup,create-package,publish-package}.{sh,bat}
├── .env.example, .env.qa, .env.stage, .env.dev
├── .vscode/, .idea/
└── playwright.config.ts     # this repo's own test runner config
```
