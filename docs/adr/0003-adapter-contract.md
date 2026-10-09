# 0003. Every external system is an Adapter that logs, times and fails the same way

- **Status:** Accepted (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
SMTP, SFTP, SQLite/DB, SAP GUI and the 3270 terminal were each growing their own logging, error and cleanup conventions, which makes a failure in one unlike a failure in another.

## Decision
Anything Playwright cannot drive implements `Adapter` (`name`, `healthCheck()`, `close()`) and runs its operations through `adapterStep`, which logs start/finish with timing and rethrows failures as `AdapterError('[adapter] operation failed: reason')` with the original as `cause`. Connection details are always passed in; an adapter never reads or stores credentials itself.

## Consequences
A new system is a new adapter, not a new set of conventions, and logs, timings and errors read the same everywhere. The cost is a little ceremony per operation, and adapters must keep secrets out of the `details` they log.

## Alternatives considered
Ad-hoc clients per system (what existed); a plugin framework (more machinery than five adapters justify).
