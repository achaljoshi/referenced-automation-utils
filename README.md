# referenced-automation-utils

Shared, framework-agnostic TypeScript utilities reused by every other `referenced-automation-*` repo (`ui`, `api`, `ui-api`, `sap`): environment config, logging, crypto, date, random test data, JSON/YAML/CSV/Excel, JSON Schema validation, dot/bracket object-path traversal, DB access, email/SMTP, and SFTP file transfer.

Nothing in here depends on Playwright or a browser - it is pure Node/TypeScript, so it is equally useful to the UI framework, the API framework, and anything else.

**New to this repo family?** See [CROSS_REPO_GUIDE.md](./CROSS_REPO_GUIDE.md) for the full picture: how the five repos share code, how to build/package/consume across them, environment setup, fixtures, overriding behavior, and a new-joiner checklist. This README covers only what's specific to `utils` itself.

## Quick start

```bash
./scripts/setup.sh      # npm ci (scripts/setup.bat on Windows)
npm test                # runs this package's own unit tests
```

This is the one repo in the family with no dependencies of its own, so its `setup.sh`/`setup.bat` are the plain case. `referenced-automation-api`, `-ui`, `-ui-api`, and `-sap` all depend on this package and their own `setup.sh`/`setup.bat` build it automatically from a sibling checkout if it isn't already packaged - see any of their READMEs for that flow. For a fresh clone of the whole family, check out all five repos next to each other in the same parent directory first.

## What's included

| Module | What it's for |
|---|---|
| `config/env` | `loadEnv()` - loads `.env.<ENV>` based on the `ENV` variable, typed `get`/`getInt`/`getBoolean`/`getList` accessors. See [Environments](#environments). |
| `logger/logger` | Console + `logs/automation.log` logging (winston), plus `loggedStep()` to wrap any action with start/pass/fail logging. Reads correctly in a terminal **and** a raw CI log - see [Logging](#logging-local-and-ci). |
| `logger/correlation` | A per-test correlation ID (`getCorrelationId`, `withCorrelationId`, `useTestCorrelation`) stamped on every log line and sent as `X-Correlation-Id` by the API client, so one failing flow can be grepped across the console, the API gateway and SAP. |
| `adapters` (`Adapter`, `adapterStep`, `AdapterError`) | The contract every outside system (SMTP, SFTP, SQLite, SAP GUI) follows: a `name`, `healthCheck()`, `close()`, and every operation logged with timing and failures wrapped as `AdapterError('[sftp] upload failed: ...')`. Write a new client against it and it behaves like the rest. |
| `testing` | In-process SMTP and SFTP servers for tests (`testing.startSmtpTestServer()`, `testing.startSftpTestServer()`), shared by every repo instead of copied into each. |
| `playwright/config` (`createPlaywrightConfig`) | One Playwright config for the whole family: `BROWSER`/`DEVICE`/timeouts/reporters from `.env.<name>`, optional log-in-once `auth` project. Each repo's `playwright.config.ts` is now ~5 lines. See [Shared Playwright config](#shared-playwright-config). |
| `crypto` | md5/sha1/sha256/sha512, hmac, base64, and `mask()` for logging sensitive values safely. |
| `dateUtils` | Thin `dayjs`-based helpers: format/parse, add days/months/hours/minutes, diff, compare, epoch conversion. |
| `randomUtils` | `@faker-js/faker`-backed test data: names, emails, addresses, UUIDs, bounded random numbers, past/future dates, credit card numbers. |
| `jsonUtils` / `yamlUtils` | Parse/stringify/read-from-file, plus `readAt()` for path-based reads on raw JSON text. |
| `csvUtils` / `excelUtils` | Read/write CSV and `.xlsx` as arrays of row objects - the shape data-driven tests want. |
| `validation` (`getPath`/`setPath`/`hasPath`/`requirePath`) | Dot/bracket path traversal over any object, e.g. `getPath(response, 'data.users[0].name')`. This is what the API framework's response wrapper is built on. |
| `validation` (`validateSchema`) | JSON Schema (draft-07/2019/2020) validation via `ajv`, with a ready-to-assert `errorsText`. |
| `db` (`DbClient`, `SqliteClient`) | A driver-agnostic query/update contract; implement it once per real DB engine your project needs. `SqliteClient` is a ready-to-use reference implementation. |
| `emailUtils` | One-off `sendEmail()` (nodemailer) and `findEmailBySubject()` to search an inbox (imapflow) - for OTP/verification-email assertions. |
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
- **Secrets are redacted** before anything is written: any value under a key that looks like `password`, `token`, `authorization`, `secret`, `api key`, `cookie` or `credential`.
- **Errors are readable**: ANSI codes from Playwright's messages are stripped, multi-line messages stay multi-line.
- **A file as well** (`logs/automation.log`, JSON lines - a CI artifact). If it can't be created (read-only checkout) the logger carries on with the console rather than failing the run.

`LOG_LEVEL` (default `info`), `LOG_TO_FILE=false`, `LOG_FILE=<path>`, `NO_COLOR=1`, `FORCE_COLOR=1`. `tests/logger.spec.ts` asserts all of this against a real child process's output.

## Adapters

Anything that talks to a system outside the test process implements `Adapter` and wraps each operation in `adapterStep`:

```ts
async upload(local: string, remote: string) {
  return adapterStep(this, 'upload', async () => { /* ... */ }, { details: { remote } });
}
```

That one wrapper gives every client the same behaviour: `[sftp] upload ... {"remote":"/in/a.csv"}` then `[sftp] upload ok (84ms)`, and on failure an `AdapterError('[sftp] upload failed: <reason>')` carrying the original as `cause`. `SmtpClient`, `SftpClient`, `SqliteClient` and the SAP GUI session (in `referenced-automation-sap`) all use it.

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

## No waits in tests

Playwright already waits inside every action and web-first assertion, so a fixed sleep is either too short (flaky) or too long (slow). The family enforces this rather than hoping:

- `ui`'s state reads (`isVisible`, `isEnabled`, `isChecked`, `count`, `allText`) **wait** up to the expect timeout; pass `{ timeout: 0 }` only to read the state *right now* (asserting something is **not** there).
- ESLint **errors** on `waitForTimeout` and on `'networkidle'` in `ui`, `sap` and `ui-api`.
- `ui/tests/noWaits.spec.ts` proves it against a page that renders late.
- The SAP GUI half has the same property by construction: every step waits for SAP to be idle and the element to exist.

## Bumping Playwright

All five repos must resolve **one** `playwright-core` (two copies mean two sets of browser revisions and confusing "executable doesn't exist" errors). The policy: a caret floor in `package.json` plus the lockfile for the exact version, and a direct `playwright-core` devDependency so npm dedupes it.

1. In each repo set `@playwright/test` **and** `playwright-core` to the new `^x.y.z` (and the peer range in `ui`/`api`/`sap`).
2. `npm install` - **keep the lockfile**. Deleting `package-lock.json` makes every version float.
3. `npx playwright install chromium` (browsers are per Playwright version).
4. `npm ls playwright-core` must show one version, `deduped` everywhere.

## Known advisory: `@faker-js/faker`

`npm audit` reports one advisory against `@faker-js/faker` v9. v10 fixes it but is ESM-only and this family compiles to CommonJS, so we stay on v9. `randomUtils` generates test data and never processes untrusted input, so the exposure is nil here; revisit when the family moves to ESM.

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

`SftpClient` deliberately isn't a wrapper around the real `winscp.com` executable - that would only work on a machine with WinSCP already installed (fine for a Windows RDP box, but not for macOS/Linux dev machines or a GitLab CI Linux runner). It's a pure Node.js SFTP implementation instead, so the same test runs identically everywhere this framework runs. `tests/support/sftpTestServer.ts` and `tests/support/smtpTestServer.ts` are real, minimal, in-process SFTP/SMTP servers - not stubs - used to test both clients against actual protocol traffic; see `tests/sftpClient.spec.ts` / `tests/smtpClient.spec.ts` for the full working examples.

## Distributing this package (no registry yet)

Until a private npm registry (e.g. Nexus) is wired up, build a versioned tarball locally and hand it out - either by copying it to a shared folder every consuming repo can read, or by giving it directly to DevOps to publish:

```bash
./scripts/create-package.sh            # writes ../shared-packages/referenced-automation-utils-<version>.tgz
./scripts/create-package.bat           # same, for Windows
```

A consuming repo then adds it exactly like any npm dependency:

```jsonc
// package.json
"dependencies": {
  "@automation/referenced-automation-utils": "file:../shared-packages/referenced-automation-utils-1.0.0.tgz"
}
```

Once Nexus (or another private registry) is available, the same tarball is what gets `npm publish`ed there - switch consumers to a normal registry version range (`"^1.0.0"`) and point `.npmrc` at the registry; nothing about the package itself changes.

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
├── scripts/{setup,create-package}.{sh,bat}
├── .env.example, .env.qa, .env.stage, .env.dev
├── .vscode/, .idea/
└── playwright.config.ts     # this repo's own test runner config
```
