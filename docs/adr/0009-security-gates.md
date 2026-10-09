# 0009. Security gates in CI: dependency audit with expiring exceptions, and secret scanning

- **Status:** Accepted pending a first green run on the real GitLab (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
`npm audit` findings were being "accepted" in prose and forgotten. New advisories arrive continuously (the first run of the gate found several high advisories and a critical one in lockfiles that had been clean). Secrets in a repository are expensive to undo.

## Decision
`automation-audit-gate` fails on advisories at or above `high` unless `audit-allowlist.json` accepts them - each exception with an owner, a reason and an **expiry date**, after which it stops applying. `automation-scan-secrets` fails on committed private keys, tokens, literal passwords, secrets in committed `.env` files and passwords typed into SAP recordings, never printing the secret. Both are a `security` job in every pipeline, non-blocking until proven on the real GitLab, then blocking.

## Consequences
Accepted risk is visible, owned and time-limited; a regression is a red build, not a surprise. Cost: someone owns the allowlist and must renew or fix entries as they expire; the audit needs a registry that supports `npm audit` (an Artifactory mirror may not - exit code 2 reports that distinctly).

## Alternatives considered
Report-only scanning (ignored in practice); a commercial scanner (not available on this network); an indefinite ignore list (the failure mode this replaces).
