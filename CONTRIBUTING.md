# Contributing to referenced-automation-utils

The shared rules (tests with negative controls, no hard waits, no secrets, ADRs, review checklist, deprecation policy) are in
[`referenced-automation-utils/docs/governance/CONTRIBUTING.md`](../referenced-automation-utils/docs/governance/CONTRIBUTING.md).
Release and upgrade steps: [`RELEASING.md`](../referenced-automation-utils/docs/governance/RELEASING.md). Decisions: [`docs/adr`](../referenced-automation-utils/docs/adr/README.md).

## Before you push
```bash
npm run lint && npm run typecheck && npm test && npm run security
```
Build first (`npm run build`): the CLIs and the stand-in bridges the tests use run from `dist/`.

Update `CHANGELOG.md`. This repo is in the chain `utils` -> `api`/`ui` -> `sap` -> `ui-api`: a change here must be repackaged (`./scripts/create-package.sh`) and re-tested in every repo above it.
