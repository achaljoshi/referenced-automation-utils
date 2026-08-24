# referenced-automation-utils

Shared, framework-agnostic TypeScript utilities reused by every other `referenced-automation-*` repo (`ui`, `api`, `ui-api`, `sap`): environment config, logging, crypto, date, random test data, JSON/YAML/CSV/Excel, JSON Schema validation, dot/bracket object-path traversal, DB access, and email.

Nothing in here depends on Playwright or a browser - it is pure Node/TypeScript, so it is equally useful to the UI framework, the API framework, and anything else.

## Quick start

```bash
./scripts/setup.sh      # npm ci (scripts/setup.bat on Windows)
npm test                # runs this package's own unit tests
```

## What's included

| Module | What it's for |
|---|---|
| `config/env` | `loadEnv()` - loads `.env.<ENV>` based on the `ENV` variable, typed `get`/`getInt`/`getBoolean`/`getList` accessors. See [Environments](#environments). |
| `logger/logger` | Console + `logs/automation.log` logging (winston), plus `loggedStep()` to wrap any action with start/pass/fail logging. |
| `crypto` | md5/sha1/sha256/sha512, hmac, base64, and `mask()` for logging sensitive values safely. |
| `dateUtils` | Thin `dayjs`-based helpers: format/parse, add days/months/hours/minutes, diff, compare, epoch conversion. |
| `randomUtils` | `@faker-js/faker`-backed test data: names, emails, addresses, UUIDs, bounded random numbers, past/future dates, credit card numbers. |
| `jsonUtils` / `yamlUtils` | Parse/stringify/read-from-file, plus `readAt()` for path-based reads on raw JSON text. |
| `csvUtils` / `excelUtils` | Read/write CSV and `.xlsx` as arrays of row objects - the shape data-driven tests want. |
| `validation` (`getPath`/`setPath`/`hasPath`/`requirePath`) | Dot/bracket path traversal over any object, e.g. `getPath(response, 'data.users[0].name')`. This is what the API framework's response wrapper is built on. |
| `validation` (`validateSchema`) | JSON Schema (draft-07/2019/2020) validation via `ajv`, with a ready-to-assert `errorsText`. |
| `db` (`DbClient`, `SqliteClient`) | A driver-agnostic query/update contract; implement it once per real DB engine your project needs. `SqliteClient` is a ready-to-use reference implementation. |
| `emailUtils` | Send mail (nodemailer) and search an inbox for a message by subject (imapflow) - for OTP/verification-email assertions. |

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
