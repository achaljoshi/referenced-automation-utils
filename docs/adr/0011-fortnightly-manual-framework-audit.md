# 0011. A fortnightly, manually triggered framework audit: automated checks plus a judgement review

- **Status:** Accepted
- **Date:** 2026-10-11
- **Approved by:** _not yet recorded_

## Context
The first independent audit (FRAMEWORK_AUDIT_2026-10-10) found defects that reading one file at a time would not: a secret scanner that misses whole classes, tests that could not fail, docs that contradicted the pipeline. Left alone, those drift back. Pipelines have never run on the real GitLab, and the network reaches only JFrog, so the audit cannot depend on an external service.

## Decision
`automation-framework-audit` (in `utils`) runs the checks that can be made from files and the repos' own scripts - waits, skips, assertions, traceability, dependencies, governance files, pipeline and documentation consistency, version drift, duplicated tests, and optionally the lint/typecheck/test/security gates - and writes a dated report with a comparison to the previous audit. It is started by hand (`npm run audit`, `scripts/audit-family.sh`, or the manual `audit` job in each pipeline) about every two weeks; nothing schedules it. What a script cannot judge (oracle quality, design techniques, flakiness causes) is the checklist at the end of each report and `docs/governance/AUDIT_PROMPT.md`. Findings are fixed, or accepted in `.framework-audit.json` with a reason (and optionally an owner and expiry), so every exception stays visible.

## Consequences
A repeatable, offline audit with a trend. The checks are heuristics (a tokenizer, not a full parser), so some findings will need an accepted exception; the exception file keeps that honest. The judgement review still costs a person's (or an assistant's) time. Report folders must be kept between audits for the comparison to work.

## Alternatives considered
A scheduled pipeline (no pipeline has run yet, and an unattended audit nobody reads is noise); only the AI-assisted review (not repeatable, not offline); relying on lint alone (cannot see pipelines, docs, dependencies or cross-repo drift).
