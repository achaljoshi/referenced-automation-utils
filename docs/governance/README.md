# Governance: how this framework family is owned, changed and released

| Document | What it settles |
|---|---|
| [`../adr/`](../adr/README.md) | The decisions that shape the family, and why |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to change a repo: tests, gates, review, deprecations |
| [`RELEASING.md`](RELEASING.md) | Versioning, the changelog, packaging, and how consumers upgrade |
| [`AUDIT.md`](AUDIT.md), [`AUDIT_PROMPT.md`](AUDIT_PROMPT.md) | The fortnightly framework audit: how to run it, what it checks, and the prompt for the deeper review |
| [`CODEOWNERS.template`](CODEOWNERS.template) | Who must review what - **to be filled in with real owners** |

## Decisions that are yours to make (this repository cannot make them for you)

- **Owners.** Each repo needs named owners (CODEOWNERS) and the dependency-audit exceptions need an owner each (`audit-allowlist.json` currently says `UNASSIGNED`).
- **Licence.** Every `package.json` says `UNLICENSED`. If the code is to be shared beyond the organisation a licence must be chosen; for internal use, `UNLICENSED` plus the organisation's own notice may be right.
- **ADR approval.** ADRs 0001-0012 are recorded (0001-0009 retrospectively, 0010-0012 together with the change they describe); an approver should confirm each (the `Approved by` line).
- **The package registry's access.** Installing by version from the registry is the flow now ([ADR 0010](../adr/0010-packages-installed-by-version-from-the-registry.md), `RELEASING.md`). What is still the platform team's to settle is the registry address (`NPM_REGISTRY_URL`), publish permission and how npm is authenticated against it; publishing itself is still a manual step.

## What is enforced automatically, and where

| Rule | Enforced by |
|---|---|
| No hard waits (`waitForTimeout`, `networkidle`) | ESLint (`no-restricted-syntax`) in `utils` (checked by `tests/lintRules.spec.ts`), `ui`, `sap`, `ui-api` |
| No floating or misused promises in code and tests | type-aware ESLint (`no-floating-promises`, `no-misused-promises`); `npm run lint` fails on any warning |
| One Playwright version in the family | a pinned range + lockfile; check with `npm ls playwright-core` |
| No secret committed | `automation-scan-secrets` (pipeline `security` job, `npm run security`) |
| No unreviewed high/critical dependency advisory | `automation-audit-gate` with an expiring allowlist |
| Type errors in test code | `npm run typecheck` (Playwright does not type-check tests) |
| The sample SAP recording and its generated tests do not rot | drift tests in `sap` compare committed output with what the converter produces |
| Ids in SAP specs belong in page objects | a lint warning in `sap` |
