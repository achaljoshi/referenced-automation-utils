# 0004. One correlation id travels through every hop of a test

- **Status:** Accepted (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
A failing end-to-end flow crosses a browser, REST calls, SAP, a database and files. Without a shared identifier, finding what one test did in each system means guessing from timestamps.

## Decision
Every test gets a correlation id (an auto fixture). It prefixes every log line (`[cid:ab12cd34]`), is sent as `X-Correlation-Id` by the API client, and flows can place it in business data (the SAP order's customer reference, a database column, a file name). Playwright runs one test at a time per worker process, so a module-level value is safe.

## Consequences
One value finds one order in the test log, the API gateway's logs and SAP. Cost: flows must choose where to carry it, and a field that is too short for the full id uses its first 8 characters consistently.

## Alternatives considered
Timestamps only (ambiguous); per-system ids (no common key); a tracing system (heavier than the need, and not available).
