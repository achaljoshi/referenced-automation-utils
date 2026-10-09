# 0006. One shared Playwright config and one Playwright version

- **Status:** Accepted (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
Five copies of `playwright.config.ts` had already drifted (one repo ran Chromium when told `BROWSER=firefox`). Two `playwright-core` versions in one install produce confusing "executable doesn't exist" failures.

## Decision
`createPlaywrightConfig()` in `utils` defines browsers, devices, timeouts, reporters (including JSON for run reports) and the optional log-in-once `auth` project, driven by `.env.<name>`. Every repo pins the same Playwright version (a caret floor plus the lockfile, with a direct `playwright-core` devDependency so npm dedupes it); the bump procedure is in `README.md`.

## Consequences
Behaviour is identical across repos and CI; a bad `BROWSER` fails with the valid names. Cost: a config change in `utils` reaches every repo on the next package install, so it needs the same care as an API change.

## Alternatives considered
Copy-pasted configs (drift); a base config file to `extends` (Playwright has no config inheritance); per-repo versions (duplicate browsers).
