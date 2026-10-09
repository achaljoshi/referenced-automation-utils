# 0005. No hard waits: waiting is built in and lint-enforced

- **Status:** Accepted (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
Fixed sleeps are the usual source of slow and flaky suites: too short on a slow day, too long on every other. The Java framework's `Thread.sleep(10000)` and 500 ms polling loops are examples. Recorded SAP scripts have no waits at all and fail at machine speed.

## Decision
Waiting is structural. Playwright actions and web-first assertions already wait; the UI package's state reads (`isVisible`, `count`...) wait too; the SAP session waits for SAP to be idle and the control to exist before every step; assertions retry. `waitForTimeout` and `'networkidle'` are ESLint errors. Where a time-boxed read is genuinely wanted, `{ timeout: 0 }` says so explicitly.

## Consequences
Tests are faster and steadier, and a failure says what was awaited. Cost: a step costs one cheap idle check, and a state read that expects "not there" must use `{ timeout: 0 }` or an assertion, or it spends the full timeout.

## Alternatives considered
Per-step sleeps; explicit waits in every test; a global slow-down factor (hides the problem).
