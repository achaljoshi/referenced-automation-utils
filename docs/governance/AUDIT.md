# The fortnightly framework audit

An audit every two weeks, started by hand, in two parts:

1. **Automated checks** - `automation-framework-audit`. Deterministic, offline, with `file:line` evidence, a dated report and a comparison with the previous audit. Takes minutes.
2. **Judgement review** - what a script cannot decide (does a test really prove what its title says? why is a test flaky?). A checklist ends every report, and [`AUDIT_PROMPT.md`](AUDIT_PROMPT.md) is the prompt for a deeper, AI-assisted review against ISTQB CTAL-TAE, TMMi and Playwright best practice.

Nothing runs by itself on a timer: you start it (below), read the report, and decide what to fix.

## Run it

**One repo** (any of the five, from its own folder):

```bash
npm run audit            # automated checks + runs this repo's lint, typecheck, test and security
npm run audit:quick      # automated checks only (seconds; does not run the gates)
```

**All five repos at once, with the checks that compare repos** (Playwright / playwright-bdd versions, duplicated tests). From `referenced-automation-utils`, with the repos checked out next to each other:

```bash
./scripts/audit-family.sh            # Windows: scripts\audit-family.bat
./scripts/audit-family.sh --run      # also run every repo's gates (slow)
```

**In GitLab** (any repo's pipeline: press play on the manual `audit` job): the automated checks, with `AUDIT_REPORT.md` and `audit.json` kept as job artifacts for 90 days. Add the variable `AUDIT_RUN_GATES=1` when starting the pipeline to run the repo's gates inside the job as well (slow; the pipeline's own jobs already run them).

Options of the command (`npx automation-framework-audit --help`): `--repo <dir>` (repeatable), `--family <dir>`, `--out <dir>` (default `audit-reports`), `--run`, `--fail-on critical|high|medium|low` (exit 1 at or above that severity; default: never fail, because the run is manual).

## What you get

`audit-reports/<date>/AUDIT_REPORT.md` and `audit.json`. The report has a severity table per repo, every finding with its evidence, the gates' results when `--run` was used, a **"since the previous audit"** section (new / resolved / still open, compared with the newest earlier folder in `audit-reports/`), and the manual checklist. Keep `audit-reports/` between audits (it is git-ignored; copy it to a shared place or keep the CI artifact) so the comparison has something to compare with.

## What the automated part checks

| Area | Checks (rule id) |
|---|---|
| Waits and flakiness | `waitForTimeout` (`wait-fixed`), `'networkidle'` (`wait-networkidle`), hand-rolled sleeps (`sleep-promise`), `test.only` (`test-only`), unconditional skip/fixme (`test-skipped`), serial mode (`serial-mode`) |
| Test quality | `{ force: true }` (`force-action`), `expect(await x.isVisible())` (`assert-not-web-first`), `toThrow()` with no expected error (`assert-weak-throw`), XPath / nth-child locators (`locator-brittle`) |
| Security | servers listening on all interfaces (`listen-all-interfaces`); the repo's own `security` gate (secret scan + dependency audit) when `--run` is used |
| Traceability | share of tests and scenarios carrying a requirement id (`traceability`), `@smoke`/`@regression` tags (`tags`) |
| Dependencies | `file:`/`.tgz` `@automation` dependencies (`dep-local-package`), unpinned `playwright-bdd` (`dep-bdd-not-pinned`), missing lockfile (`dep-no-lockfile`), version drift between repos (`family-version-drift`) |
| Governance | CODEOWNERS (`gov-codeowners`), accepted advisories without owner / expired / expiring (`gov-allowlist-*`), unapproved ADRs (`gov-adr-approval`), licence (`gov-licence`) |
| Pipeline | no pipeline (`ci-missing`), security job that cannot block (`ci-security-nonblocking`), no typecheck step (`ci-no-typecheck`), features never generated (`ci-bdd-not-generated`), image vs Playwright version (`ci-image-mismatch`), shared template not used (`ci-no-shared-template`) |
| Docs | broken links and anchors (`doc-broken-link`), retired procedures still described (`doc-stale-phrase`), README image differs from the pipeline's (`doc-image-mismatch`) |
| Duplication | the same test file in several repos (`family-duplicated-tests`) |
| Gates (`--run`) | failing lint / typecheck / test / security, a run that executed zero tests, flaky and skipped tests (`run-*`) |

Not checked automatically, on purpose: whether an assertion is a good oracle, whether a design technique was used where it should be, whether a flaky test's cause is understood. That is the manual part.

## Requirement traceability

Put an id in the test title, a tag, or an annotation, and the audit counts it. The default pattern is `@REQ-<id>` (or `REQ-<id>`); change it per repo with `requirementPattern` in `.framework-audit.json` to match your tracker (for example `JIRA-\d+`):

```ts
test('applies the late-payment surcharge @REQ-PAY-102 @regression', async () => { ... });
```
```gherkin
@REQ-PAY-102 @regression
Scenario: Late payment surcharge is applied
```

## Accepting a finding on purpose

Edit `.framework-audit.json` in the repo. Every exception needs a reason a reviewer can judge, and can expire:

```json
{
  "ignore": [
    { "rule": "sleep-promise", "path": "tests/pool.spec.ts", "reason": "tests the stale-lock timeout, which is time itself", "owner": "platform", "expires": "2027-04-30" }
  ],
  "requirementPattern": "REQ-[A-Za-z0-9_-]+",
  "staleDocPhrases": ["file:../shared-packages", "no registry yet"],
  "traceabilityTarget": 0.5
}
```

Accepted exceptions are listed in the report, so they stay visible. When a procedure is retired, add its wording to `staleDocPhrases` so documents that still describe it are caught.

## After the audit

Triage with the team: fix, accept with a reason (above), or open a ticket. Record what you decided in the report folder (or the ticket), and fold any recurring pattern into a lint rule or a new automated check in `src/governance/frameworkAudit.ts`.

The deeper, AI-assisted review is [`AUDIT_PROMPT.md`](AUDIT_PROMPT.md): paste it into an assistant with the repos attached (or run it in a session that can read them), and give it the newest `AUDIT_REPORT.md` so it concentrates on what the script cannot see. Treat its ISTQB and TMMi mappings as indicative; a TMMi rating needs an accredited assessment.
