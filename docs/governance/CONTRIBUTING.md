# Contributing to the automation framework family

Applies to `referenced-automation-utils`, `-api`, `-ui`, `-sap` and `-ui-api`. Each repo has a short `CONTRIBUTING.md` with its own commands; this is the shared part.

## Before you start
- A change that is **hard to reverse, affects more than one repo, or will make a newcomer ask "why?"** gets an ADR (`docs/adr/`, copy `0000-template.md`) in the same merge request as the code.
- Shared repos form a chain: `utils` -> `api` / `ui` -> `sap` -> `ui-api`. A change low in the chain must be repackaged and re-tested in everything above it before it merges (see `RELEASING.md`).

## Every change
1. **Tests with the change.** New behaviour has a test; a bug fix has a test that fails without the fix. Where a framework behaviour is "it waits" or "it is safe", include a **negative control**: a test showing the same thing without the behaviour fails.
2. **The gates are green locally:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run security`.
3. **No hard waits** (`waitForTimeout`, `networkidle`); wait on a condition, assertion or auto-waiting action.
4. **No secrets** in code, specs, logs, fixtures, recordings or `.env.<name>` (use `.env.<name>.local` or CI variables). A test credential that is genuinely made up goes in `.secretscan-allow.json` with a reason.
5. **Logging:** adapters log through `adapterStep`; never log a secret, never `console.log`.
6. **Update the docs** that describe the behaviour you changed, and the `CHANGELOG.md`.
7. **Do not delete `package-lock.json`** to "fix" an install: it makes every dependency (Playwright included) float.

## Writing tests
- Page objects own selectors and ids; tests say what happens (see each repo's README).
- Prefer web-first assertions that retry. `expect.soft` when you want every failure reported.
- Tag tests (`@smoke`, `@regression`, `@e2e`, `@sapgui`) so pipelines can select them.
- Tests must not depend on each other or on data a previous run left behind (use the data registry in `sap`; unique values).

## Review checklist
- [ ] Does it have a test, and a negative control where a safety/waiting claim is made?
- [ ] Could it leak a secret into a log, report, recording or generated file?
- [ ] Does it change a public export, an env variable or a default? (Then: changelog, version bump, deprecation.)
- [ ] Does it need an ADR?
- [ ] Is anything claimed in the docs or commit message that was not actually run? Say what is **not verified**.

## Deprecating something
Announce it in the changelog and in the code (`@deprecated` with the replacement) in one minor version; keep it working for at least two further minor versions; remove it only in a major version. Never change the behaviour of something without changing its version.

## Commits and merge requests
Imperative subject line, a body that explains *why*; one logical change per commit. Do not commit generated output other than the committed examples that drift tests guard. State plainly in the merge request what was and was not verified (for example "not run against a real SAP GUI").
