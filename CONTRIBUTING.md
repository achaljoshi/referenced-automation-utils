# Contributing to referenced-automation-utils

The shared rules (tests with negative controls, no hard waits, no secrets, ADRs, review checklist, deprecation policy) are in
[`referenced-automation-utils/docs/governance/CONTRIBUTING.md`](../referenced-automation-utils/docs/governance/CONTRIBUTING.md).
Release and upgrade steps: [`RELEASING.md`](../referenced-automation-utils/docs/governance/RELEASING.md). Decisions: [`docs/adr`](../referenced-automation-utils/docs/adr/README.md).

## Before you push
```bash
npm run lint && npm run typecheck && npm test && npm run security
```
Build first (`npm run build`): the CLIs and the stand-in bridges the tests use run from `dist/`.

On Windows: Windows PowerShell 5.1 has no `&&` (PowerShell 7 and cmd.exe do) - run the four commands one per line, and note that `;` would carry on after a failure. Inside this repo the CLIs are the npm scripts `remote`, `run-report`, `scan-secrets`, `audit-gate` and `framework-audit` (`npm run scan-secrets`); `npx automation-scan-secrets` and friends work only in a project that depends on this package. See the README, "Windows first run".

Update `CHANGELOG.md`. This repo is in the chain `utils` -> `api`/`ui` -> `sap` -> `ui-api`: a change here is released as a new version (`./scripts/publish-package.sh`, see the README: "Publishing a package to the registry") and every repo above it moves to that version in its `package.json` (README: "Upgrading a package") and is re-tested.
