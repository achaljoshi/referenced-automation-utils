# referenced-automation-utils

Shared, framework-agnostic TypeScript utilities reused by every other `referenced-automation-*` repo (`ui`, `api`, `ui-api`, `sap`): environment config, logging, crypto, date, random test data, JSON/YAML/CSV/Excel, JSON Schema validation, dot/bracket object-path traversal, DB access, email/SMTP, and SFTP file transfer.

Nothing in here depends on Playwright or a browser - it is pure Node/TypeScript, so it is equally useful to the UI framework, the API framework, and anything else.

**New to this repo family?** See [CROSS_REPO_GUIDE.md](./CROSS_REPO_GUIDE.md) for the full picture: how the five repos share code, how to build/package/consume across them, environment setup, fixtures, overriding behavior, and a new-joiner checklist. This README covers only what's specific to `utils` itself.

## Quick start

```bash
./scripts/setup.sh      # npm ci
npm test                # runs this package's own unit tests
```

```powershell
.\scripts\setup.bat     # Windows PowerShell: npm ci (plain `scripts\setup.bat` works only in cmd.exe)
npm test
```

First time on Windows? Read [Windows first run](#windows-first-run) - it lists the errors a fresh checkout usually hits and what fixes each.

`setup.sh`/`setup.bat` run `npm ci`. They first run `npm config set registry "$NPM_REGISTRY_URL"` when that variable is set, so every package is fetched from your organisation's npm registry (see [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory)). This package has no `@automation/*` dependencies of its own.

**Setup stops with a certificate error** (`self-signed certificate in certificate chain`, `unable to get local issuer certificate`)? A company proxy that re-signs HTTPS with its own root certificate is the usual cause. `setup` checks for it first (`scripts/check-tls.js`: the npm registry and, where browsers are installed, the Playwright download host) and prints the exact fix: give Node the company root CA certificate (a `.pem` file from IT) through `NODE_EXTRA_CA_CERTS`, or on Node 22.15 or newer let it read the operating system's certificate store with `NODE_OPTIONS=--use-system-ca`. Do not work around it with `NODE_TLS_REJECT_UNAUTHORIZED=0`: that turns certificate checking off for every Node program started from that shell, npm included. The check connects directly from this machine; it does not use a proxy setting, so a machine that can only reach the registry through a proxy shows "could not connect" and setup carries on.

## Windows first run

Everything below is PowerShell, started in the folder this repo is checked out in (`cd C:\Projects\referenced-automation-utils`). This package has no `@automation/*` dependencies and drives no browser, so there is no `--local` mode and no browser to install - the sibling repos (`api`, `ui`, `ui-api`, `sap`) are the ones that need those.

```powershell
.\scripts\setup.bat      # npm ci. In PowerShell the .\ is required; scripts\setup.bat works only in cmd.exe
npm run build            # tsc -> dist/ (npm test does this too, through "pretest")
npm test                 # the unit tests; all of them should pass
```

Run less than everything (forward slashes, also on Windows):

```powershell
npx playwright test tests/env.spec.ts            # one file
npx playwright test tests/env.spec.ts:12         # the test that starts at line 12 of that file (12 is an example)
npx playwright test -g "getBoolean"              # by (part of) the test title
```

Set an environment variable for one run, then undo it (`ENV=stage npx playwright test` is bash syntax and fails in PowerShell):

```powershell
$env:ENV = "stage"; $env:LOG_LEVEL = "debug"; npx playwright test tests/logger.spec.ts
Remove-Item Env:ENV, Env:LOG_LEVEL
```

The command-line tools of this package, run **inside this repo** (after `npm run build`): `npm run remote -- doctor`, `npm run run-report -- --input test-results/results.json`, `npm run scan-secrets`, `npm run audit-gate -- --allow-unassigned`, `npm run framework-audit -- --out audit-reports`. See [Command-line tools](#command-line-tools) for why `npx automation-remote ...` fails here.

Common first errors:

| What you see | Why | Fix |
|---|---|---|
| `'tsc' is not recognized as an internal or external command` (or `'playwright'`, `'eslint'`, `'rimraf'`) | There is no `node_modules`: the install did not run or stopped with an error. | Run `.\scripts\setup.bat` again and read the **first** error it prints (registry not reachable, `NPM_REGISTRY_URL` wrong, no network). `Test-Path node_modules\.bin\tsc.cmd` must say `True`. |
| `Cannot find module '...\dist\...'` (`dist\index.js`, `dist\cli\remote.js`) | The TypeScript has not been compiled yet: `dist/` is git-ignored and built on demand. | `npm run build`. (`npm test` builds first on its own.) |
| `Error: No tests found` | The file pattern matched nothing. Backslash paths (`tests\env.spec.ts`) are the usual cause: Playwright takes the argument as a regular expression in which a backslash escapes the next character, so `tests\env.spec.ts` never matches the file `tests/env.spec.ts`. Running from another folder, or a file that is not under `tests/` and named `*.spec.ts`, does the same. | `npx playwright test tests/env.spec.ts` (forward slashes), from the repo root; or select by title with `-g "title"`. |
| `error TS5108: Option 'moduleResolution=node10' has been removed` in `tsconfig.json` (VS Code or a machine with TypeScript 7) | TypeScript 7 removed `moduleResolution: "node"`; it has nothing to do with the Node.js version | `tsconfig.json` now uses `"module": "node16"` and `"moduleResolution": "node16"` (same compiled output): `git pull`, or change those two lines by hand |
| `Illegal characters in path` mentioning `*.tgz` | An old `clean` script (`rimraf dist *.tgz`): Windows does not expand the `*` and rimraf passed it on as a file name. | Fixed: the script is `rimraf --glob dist "*.tgz"`. Pull the latest version of the repo and run `npm run clean` again. |
| `'automation-remote' is not recognized as an internal or external command` (also `automation-run-report`, `automation-scan-secrets`, `automation-audit-gate`, `automation-framework-audit`) | A package's own `bin` commands are not linked into its own `node_modules/.bin`; `npx <command>` works only in a project that **depends on** this package. | Inside this repo use `npm run remote -- doctor` (aliases: `remote`, `run-report`, `scan-secrets`, `audit-gate`, `framework-audit`) or `node dist/cli/remote.js doctor`. |
| `'ENV' is not recognized` / `The term 'ENV=qa' is not recognized` | `NAME=value command` is bash syntax. | PowerShell: `$env:ENV = "qa"; npx playwright test`. cmd.exe: `set ENV=qa && npx playwright test`. |
| `The token '&&' is not a valid statement separator in this version` | Windows PowerShell 5.1 has no `&&` (PowerShell 7 and cmd.exe do). | Run the commands one per line (`npm run lint`, then `npm run typecheck`, ...), or use PowerShell 7. A `;` would carry on after a failure, so do not use it to chain gates. |
| `npm.ps1 cannot be loaded because running scripts is disabled on this system` | PowerShell's execution policy blocks npm's `.ps1` launcher. | Run `npm.cmd run build` (or use cmd.exe), or ask your administrator about the execution policy - this repo does not change it. |
| A setting in a `.env` file seems ignored | Either the file name is wrong (the secret file for `ENV=qa` is `.env.qa.local`; a file called `.env.local` is never read) or the variable is one that is read from the **real environment only** (`LOG_LEVEL`, `RANDOM_SEED`, `CI`, ...). | Check the "Read from" line of that variable in [`.env.example`](.env.example) and the [Configuration reference](#configuration-reference); set real-environment variables with `$env:NAME = "value"`. |

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
| `remote` (`RemoteHost`, `RemoteDbClient`, `getRemoteHost`) | Runs DB / HTTP / SAP-bridge / other steps on a remote Windows desktop host that the test machine (for example an AWS WorkSpace) can reach only by Remote Desktop: requests travel as files over one redirected drive to a PowerShell agent in the RDP session. **Not verified on a real Windows host.** See [Running steps on a remote desktop](#running-steps-on-a-remote-desktop). |
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

## Command-line tools

| Command (for a project that depends on this package) | npm script, inside this repo | What it is for |
|---|---|---|
| `npx automation-remote <command>` | `npm run remote -- <command>` | Remote desktop host: `doctor`, `check`, `open`, `close`, `agent-dir`, `setup-help` ([docs/REMOTE_DESKTOP.md](docs/REMOTE_DESKTOP.md)) |
| `npx automation-run-report ...` | `npm run run-report -- ...` | Summarise a Playwright run and gate it ([Run report](#run-report-and-test-gates)) |
| `npx automation-scan-secrets` | `npm run scan-secrets -- ...` | Fail when a secret is about to be committed ([Secret scan](#secret-scan)) |
| `npx automation-audit-gate` | `npm run audit-gate -- ...` | Fail on dependency advisories without an owned, expiring exception ([Dependency audit gate](#dependency-audit-gate)) |
| `npx automation-framework-audit ...` | `npm run framework-audit -- ...` | The fortnightly framework audit ([docs/governance/AUDIT.md](docs/governance/AUDIT.md)) |

A package's own `bin` commands are **not** linked into its own `node_modules/.bin`, so the `npx automation-...` form (left column) works only from a project that depends on `@automation/referenced-automation-utils`; run inside this repo it fails with `'automation-remote' is not recognized as an internal or external command` on Windows (`command not found` or a registry lookup elsewhere). Inside this repo use the npm script (middle column; the `--` hands everything after it to the tool) or `node dist/cli/<file>.js <arguments>` - both need `npm run build` first. `tests/windowsDocs.spec.ts` checks that every `bin` has such a script and that no document shows the `npx` form for this repo's own commands without saying where it works.

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

**These are read from the real environment only** (the logger reads `process.env` once, when it is first imported), so `LOG_LEVEL=debug` written into `.env.qa` changes nothing. Set it where the process starts: `LOG_LEVEL=debug npx playwright test` in bash, `$env:LOG_LEVEL = "debug"; npx playwright test` in PowerShell (undo with `Remove-Item Env:LOG_LEVEL`), or a CI variable. The "Read from" line of every variable in [`.env.example`](.env.example) says which kind it is.

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

## Running steps on a remote desktop

When the database, the APIs and SAP GUI are reachable only from a remote Windows desktop host (no internet there, only Remote Desktop on port 3389 open), `remote` runs those steps *on* that host while the UI steps stay on the test machine (for example an AWS WorkSpace). Put the RDP login in `.env.<env>.local`, set `REMOTE_ENABLED=true`, and:

```ts
const host = await remote.getRemoteHost();   // undefined unless REMOTE_ENABLED=true - use the local services then
const { rows } = await host!.dbQuery('SELECT TOP 1 * FROM orders WHERE id = @p0', [42]);
const reply = await host!.http({ method: 'GET', url: 'https://internal-api/health' });
```

`automation-remote doctor` checks the local prerequisites and `automation-remote check` walks the chain stage by stage (inside this repo: `npm run remote -- doctor`; from a dependent project: `npx automation-remote doctor` - see [Command-line tools](#command-line-tools)). The `api` and `sap` packages will use it in follow-up work in their own repos. **The Windows side (RDP launcher, PowerShell agent) has never run on a real Windows host** - what is and is not verified, the setup per start mode, the settings, the security trade-offs and troubleshooting are in [docs/REMOTE_DESKTOP.md](docs/REMOTE_DESKTOP.md) and [ADR 0012](docs/adr/0012-remote-host-over-rdp-drive-mailbox.md).

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

Everything else comes from `.env.<name>` or the environment (`BROWSER`, `DEVICE`, `HEADLESS`, `WORKERS`, `RETRIES`, `TEST_TIMEOUT_MS`, ...; the full list, with values and defaults, is the [Configuration reference](#configuration-reference)). An unknown `BROWSER` fails immediately with the valid names instead of silently running chromium. Log in once and reuse it everywhere with `auth: { setupMatch: /auth\.setup\.ts/, storageState: AUTH_FILE }` - see `referenced-automation-ui-api` for a working example.

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

`npm run audit-gate -- <options>` (from a dependent project: `npx automation-audit-gate <options>`) runs `npm audit` and fails (exit 1) on any advisory at or above `--level` (default `high`) that is not covered by an **explicit, owned, expiring** entry in `audit-allowlist.json`:

```json
{ "allow": [ { "id": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "why this is acceptable", "owner": "team or person", "expires": "2027-03-31" } ] }
```

An exception stops protecting you on its expiry date, so an accepted risk has to be re-decided on purpose rather than forgotten; entries that match nothing any more are reported (`--strict-allowlist` fails on them), and an exception inside 30 days of expiry warns. Every entry needs `package`, a real `owner` (empty or `UNASSIGNED` is an error unless you pass `--allow-unassigned`) and an expiry no more than a year away (`--max-expiry-days` changes the limit). Exit codes: **1** the gate failed - a blocking advisory, an allowlist that breaks those rules, or an audit report the tool does not understand (it requires `auditReportVersion` 2 and a `metadata.vulnerabilities.total` that matches, and fails closed otherwise); **2** the audit could not run (offline, no registry, `npm` missing). The shared CI template lets only exit code 2 fail without blocking.

**Currently accepted here:** `@faker-js/faker` GHSA-qxc2-j82w-r537 (high). The fix is v10.5+, which is ESM-only, and this family compiles to CommonJS on Node >=18, so it needs an ESM migration. Nothing in the family's own code calls `faker.helpers.fake()`, but `randomUtils` re-exports the whole faker API, so a project must not pass untrusted input to it. The entry has **no owner yet** (so `npm run security` and the pipeline pass `--allow-unassigned` for now) and expires 2027-03-31 - name an owner in `audit-allowlist.json` and drop the flag.

## Secret scan

`npm run scan-secrets` (from a dependent project: `npx automation-scan-secrets`; also part of `npm run security` and the pipeline's `security` job) fails when a secret is about to be committed: private keys, cloud/CI tokens, **JWTs**, `Authorization: Bearer|Basic` headers (including `curl -H`) and `curl -u`, passwords in URLs and **connection strings**, literal passwords assigned in code, **JSON** `"password": "..."` values, **unquoted** YAML / properties / shell / Dockerfile values, secrets typed into **Gherkin steps**, committed `.env` secrets and SAP recordings. Placeholders (`${VAR}`, `<token>`, `{{env:X}}`, `changeme`, `true`, `null`, ...) are skipped by an *anchored* test: a real secret that merely starts with `true...` or `null...` is still found. It never prints a secret - every occurrence in a line is masked, whichever rule found it. Every tracked file is scanned even under `node_modules/` or `logs/` (a committed secret is in the history); only *untracked* files in generated directories are left out, and the summary counts what was not scanned (generated, binary, over 1 MB, unreadable). Intentional exceptions go in `.secretscan-allow.json`, with a reason.

## Run report and test gates

`npm run run-report -- --input test-results/results.json --out report.md` (from a dependent project: `npx automation-run-report --input test-results/results.json --out report.md`) summarises a run (failures, flaky tests, slowest tests, repeat offenders across `--history`) and gates it: `--min-executed N` (default 1: an empty or all-skipped run is not a pass; `0` allows it), `--fail-on-flaky N`, and it always fails when the report carries top-level errors (a failed global setup). A corrupt history line is skipped and counted; numeric options are validated and an unknown option is an error, so a typo cannot switch a gate off. Exit codes: 0 ok, 1 a gate failed, 2 unreadable report or bad command line.

## Environments

Every consuming repo follows the same pattern: `.env.<name>` files at the repo root (committed, no secrets), an optional `.env.<name>.local` (gitignored, for real credentials), selected at runtime by the `ENV` variable:

```bash
ENV=qa npx playwright test      # loads .env.qa
ENV=stage npx playwright test   # loads .env.stage
```

```powershell
$env:ENV = "stage"; npx playwright test      # PowerShell: loads .env.stage; `ENV=stage npx ...` is bash-only
Remove-Item Env:ENV                          # back to the default (qa)
```

The files are read in this order, later wins: `.env` -> `.env.<ENV>` -> `.env.<ENV>.local` -> the real environment. The secret file is named after the environment (`.env.qa.local` for `ENV=qa`); a file called just `.env.local` is **not** read. Values with `#`, `$`, quotes or spaces must be wrapped in double quotes. [`.env.example`](.env.example) documents every variable (what it is for, valid values, default, required or not, secret or not, an example) and [`.env.local.example`](.env.local.example) is the template for the secret file.

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

## Configuration reference

Every environment variable this package reads, in the order of [`.env.example`](.env.example), which documents each one in full (valid values, whether a `.env` file or only the real environment is read, an example). `tests/envDocs.spec.ts` fails when this table, `.env.example` and the code drift apart. Secrets (the **YES** rows) belong in `.env.<ENV>.local` (template: [`.env.local.example`](.env.local.example)) or the CI secret store, never in a committed file. The other repos (`api`, `ui`, `ui-api`, `sap`) share these keys; their own READMEs link here for them and add their own.

### Environment selection

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `ENV` | Which environment to run against = which .env.<name> files are loaded and what is shown as "env" in the report | qa | no | no |
| `ENVIRONMENT` | Fallback name for ENV, for machines where another tool already owns ENV. ENV wins when both are set | unset (then qa) | no | no |

### Target URLs

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `BASE_URL` | Base URL of the web application | unset | no for the config itself; yes for any test that opens a relative URL | no |
| `API_BASE_URL` | Base URL of the API under test (what API suites pass as baseUrlKey to createPlaywrightConfig) | unset | no for the config itself; yes for any test that calls a relative path | no |

### Browser and run selection

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `BROWSER` | Which browser(s) to run | chromium | no | no |
| `DEVICE` | Emulate one Playwright device instead of a desktop browser; wins over BROWSER. An unknown name fails at start-up | unset (then BROWSER decides) | no | no |
| `HEADLESS` | Run the browser without a window | true | no | no |
| `WORKERS` | How many test files run at the same time | unset (Playwright uses half of the logical cores) | no | no |
| `RETRIES` | How often a failed test is run again before it counts as failed (a test that passes on a retry is reported as flaky) | 0 on a developer machine; 1 when the CI variable is set (the repo's retriesOnCi option can change that) | no | no |
| `MAX_FAILURES` | Stop the whole run after this many failed tests | 0 | no | no |
| `SLOW_MO_MS` | Slow every browser action down so a person can watch (debugging only) | 0 | no | no |
| `VIEWPORT_WIDTH` | Width of the browser window for desktop projects | 1280 | no | no |
| `VIEWPORT_HEIGHT` | Height of the browser window for desktop projects | 800 | no | no |
| `LOCALE` | Browser language (navigator.language, Accept-Language, date and number formats) | unset (the browser's own) | no | no |
| `TIMEZONE_ID` | Browser time zone, so date assertions do not depend on where the test machine is | unset (the machine's own) | no | no |
| `COLOR_SCHEME` | Emulated prefers-color-scheme | unset (the browser's own) | no | no |
| `IGNORE_HTTPS_ERRORS` | Accept invalid or self-signed HTTPS certificates (test environments only) | false | no | no |
| `TEST_ID_ATTRIBUTE` | The attribute getByTestId() looks at | data-testid | no | no |

### Timeouts, all in milliseconds

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `TEST_TIMEOUT_MS` | How long one whole test may take | 30000 (a repo can change the default through the testTimeoutMs option) | no | no |
| `EXPECT_TIMEOUT_MS` | How long a web-first assertion (expect(...)) waits for its condition | 10000 | no | no |
| `ACTION_TIMEOUT_MS` | How long one action (click, fill, ...) waits for its element | 15000 | no | no |
| `NAVIGATION_TIMEOUT_MS` | How long a navigation (page.goto, link clicks) waits | 30000 | no | no |
| `GLOBAL_TIMEOUT_MS` | How long the whole run may take before Playwright stops it | 0 | no | no |

### Logging

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `LOG_LEVEL` | Minimum level written to the console and the log file | info | no | no |
| `LOG_TO_FILE` | Also write the JSON-lines log file (a CI artifact) | true | no | no |
| `LOG_FILE` | Where the log file is written | logs/automation.log | no | no |
| `LOG_FILE_PER_WORKER` | One log file per Playwright worker (logs/automation-w2.log) instead of every worker appending to one file | false | no | no |
| `NO_COLOR` | Switch coloured console output off | unset | no | no |
| `FORCE_COLOR` | Switch coloured console output on even in CI or when the output is piped | unset | no | no |

### Test data

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `RANDOM_SEED` | Seeds the random-data generators (randomUtils, {{random:...}} placeholders) for every Playwright worker, so a failing | unset (a different random seed every run) | no | no |

### Mainframe

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `S3270_PATH` | The s3270 program (from the x3270 suite) that Tn3270Session drives | s3270 (looked up on the PATH) | no | no |
| `TN3270_TIMEOUT_MS` | How long a 3270 wait (waitForText, waiting for the keyboard to unlock) lasts before it fails with the screen as it was | 30000 | no | no |

### Remote desktop host

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `REMOTE_ENABLED` | Master switch for the remote host | false | no | no |
| `REMOTE_RDP_HOST` | Host name or address of the RDP host (no scheme, path or spaces) | unset | yes when REMOTE_ENABLED=true | no |
| `REMOTE_RDP_PORT` | RDP port of the host | 3389 | no | no |
| `REMOTE_RDP_USER` | Login for the RDP host | unset | yes with REMOTE_AGENT_START=alternate-shell (this machine logs in for you); no for startup / manual | no |
| `REMOTE_RDP_PASSWORD` | Password for REMOTE_RDP_USER. Handed to mstsc through cmdkey only while it connects | unset | yes with REMOTE_AGENT_START=alternate-shell | **YES** |
| `REMOTE_RDP_DOMAIN` | Domain of the login, as an alternative to writing DOMAIN\user in REMOTE_RDP_USER (a contradiction between the two is an error) | unset | no | no |
| `REMOTE_SHARE_DIR` | The mailbox folder on the test machine: requests and answers travel through it as files | <folder tests start in>/.remote-mailbox | no | no |
| `REMOTE_DRIVE_LETTER` | The drive letter (made with subst) that is redirected into the RDP session | R | no | no |
| `REMOTE_AGENT_START` | How the agent gets started inside the RDP session of the host | alternate-shell | no | no |
| `REMOTE_ALLOW` | What the agent may be asked to do | http,db,sap | no | no |
| `REMOTE_CONNECT_TIMEOUT_MS` | How long connect() waits for the agent's first heartbeat | 180000 | no | no |
| `REMOTE_REQUEST_TIMEOUT_MS` | How long one request waits for its answer, unless the caller passes its own timeout | 60000 | no | no |
| `REMOTE_POLL_MS` | How often the client (and the agent) look at the mailbox folder | 200 | no | no |
| `REMOTE_HEARTBEAT_MS` | How often the agent writes its heartbeat file | 2000 | no | no |
| `REMOTE_HEARTBEAT_STALE_MS` | A heartbeat older than this means the agent is gone (AGENT_STALE) | 10000 | no | no |
| `REMOTE_RDP_WIDTH` | Width of the RDP desktop | 1280 | no | no |
| `REMOTE_RDP_HEIGHT` | Height of the RDP desktop | 800 | no | no |
| `REMOTE_RDP_KEEP_OPEN` | Leave the RDP session running after the tests (true), or shut it down and close our mstsc (false) | false | no | no |
| `REMOTE_LOGOFF` | close() also logs the Windows session on the host off (for startup / manual, where the session would otherwise stay) | false | no | no |
| `REMOTE_DB_PROVIDER` | The .NET DbProviderFactories invariant name used for database steps on the host | unset | yes for database steps on the host | no |
| `REMOTE_DB_CONNECTION_STRING` | The database connection string AS THE HOST uses it | unset | yes for database steps on the host | **YES** |

### Connection details the CALLER reads

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `SMTP_HOST` | SMTP server for SmtpClient / sendEmail | unset | only if your tests send mail | no |
| `SMTP_PORT` | SMTP port | unset | only if your tests send mail | no |
| `SMTP_SECURE` | Use TLS from the first byte (port 465) instead of STARTTLS | unset | only if your tests send mail | no |
| `SMTP_USER` | SMTP login name | unset | only if the server needs a login | no |
| `SMTP_PASS` | SMTP password | unset | only if the server needs a login | **YES** |
| `SFTP_HOST` | SFTP server for SftpClient | unset | only if your tests use SFTP | no |
| `SFTP_USER` | SFTP login name | unset | only if your tests use SFTP | no |
| `SFTP_PASSWORD` | SFTP password | unset | only if your tests use SFTP | **YES** |

### Set by the machine, not by you

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `CI` | CI systems set this (GitLab: CI=true) | unset | no (do not set it by hand unless you want the CI behaviour locally) | no |
| `TEST_WORKER_INDEX` | Playwright sets this for every worker (0, 1, 2, ...); the logger prints it as [w2] and uses it for LOG_FILE_PER_WORKER. Do not set it yourself | unset outside a Playwright worker | no | no |
| `TZ` | The time zone of the Node process (dates, logs) | the machine's own time zone | no | no |
| `SESSIONNAME` | Windows sets this for an interactive logon (console or Remote Desktop); `automation-remote doctor` reads it to warn when the process is not on an interactive desktop (SAP GUI scripting needs one) | unset outside Windows | no | no |
| `NPM_REGISTRY_URL` | The npm registry that scripts/setup.sh\|.bat, create-package and publish-package install from | unset (npm keeps the registry it already uses; publish-package refuses to run without it) | no for setup, yes for publish-package | no |

### CI/CD variables

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `AUTOMATION_MIN_EXECUTED` | Gate of the merge job: fail the pipeline when fewer tests than this actually ran (an all-skipped run is not a pass) | 1 | no | no |
| `AUTOMATION_FAIL_ON_FLAKY` | Gate of the merge job: fail the pipeline when this many tests needed a retry to pass | 3 | no | no |
| `AUDIT_RUN_GATES` | Make the manual `audit` job also run lint, typecheck, test and security in the repo (slow) | unset (only the automated checks) | no | no |
| `PLAYWRIGHT_DOWNLOAD_HOST` | Mirror of Playwright's browser download CDN (for example in Artifactory), used by `npx playwright install` in the pipeline | unset (Playwright's own CDN) | no | no |

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
   export NPM_REGISTRY_URL="<your registry URL>"
   ```
   ```powershell
   $env:NPM_REGISTRY_URL = "<your registry URL>"        # PowerShell (cmd.exe: set NPM_REGISTRY_URL=<your registry URL>)
   ```
5. **Publish** - a dry run first:
   ```bash
   ./scripts/publish-package.sh --dry-run     # builds the package and lists what would be uploaded
   ./scripts/publish-package.sh               # uploads it            (PowerShell: .\scripts\publish-package.bat, add --dry-run first)
   ```
   The script runs `npm config set registry "$NPM_REGISTRY_URL"`, builds with `create-package.sh` (clean, build, `npm pack`) and runs `npm publish <the .tgz> --registry "$NPM_REGISTRY_URL"`.
6. **Check it arrived:** `npm view @automation/referenced-automation-utils versions --registry "$NPM_REGISTRY_URL"` lists the new version.

**Without the script.** `./scripts/create-package.sh` leaves `../shared-packages/automation-referenced-automation-utils-<version>.tgz`, the exact file `npm publish` uploads. Publish that file yourself (`npm publish ../shared-packages/<file>.tgz --registry "$NPM_REGISTRY_URL"`), or deploy the `.tgz` into the npm repository through the Artifactory web UI (the repository's **Deploy** action - Artifactory takes the package name and version from the tarball; check with your platform team how your repository is set up), or hand it to whoever manages the repository.

**Order matters.** Publish what a package depends on first: `utils` -> `api` and `ui` -> `sap` -> the consuming repos.

## First rollout: publish, then install from the registry

To see the whole chain work from the registry (no `--local`): set `NPM_REGISTRY_URL`, publish `utils`, `api`, `ui`, `sap` **in that order** (`./scripts/publish-package.sh --dry-run`, then without `--dry-run`, in each repo; the first publish uses the current version, 1.0.0), confirm with `npm view @automation/referenced-automation-<name> versions --registry "$NPM_REGISTRY_URL"`, then in a consumer run `rm -rf node_modules && ./scripts/setup.sh` (PowerShell: `Remove-Item -Recurse -Force node_modules; .\scripts\setup.bat`) and check `npm ls @automation/referenced-automation-utils` and the `resolved` address in `package-lock.json`. The full walkthrough is [section 4.3 of the cross-repo guide](https://github.com/achaljoshi/referenced-automation-utils/blob/master/CROSS_REPO_GUIDE.md#43-first-rollout-publish-everything-then-install-from-the-registry).

## Using a package without a registry (local generation)

Use this when the packages are not in a registry yet, or you want to try a change before publishing it. Nothing in `package.json` or the lockfile changes.

**Automatic - when the repos are checked out next to each other:**

```bash
./scripts/create-package.sh          # PowerShell: .\scripts\create-package.bat
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
│   ├── remote/              # steps on a remote desktop host over RDP (docs/REMOTE_DESKTOP.md)
│   └── index.ts             # barrel export - this is what `import ... from '@automation/referenced-automation-utils'` resolves to
├── agent/                  # SHIPPED: remote-agent.ps1 + start.cmd, copied into the RDP mailbox
├── tests/                  # this package's own unit tests, NOT shipped
├── scripts/{setup,create-package,publish-package}.{sh,bat}
├── .env.example (every variable, documented), .env.local.example (secrets template), .env.qa, .env.stage, .env.dev
├── .vscode/, .idea/
└── playwright.config.ts     # this repo's own test runner config
```
