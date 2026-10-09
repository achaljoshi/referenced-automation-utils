# Architecture decision records

One short file per decision that shapes the whole framework family: what was decided, why, what it costs, and what else was considered. Write one when a decision is hard to reverse, affects more than one repo, or will make a newcomer ask "why is it like this?". Copy `0000-template.md`, take the next number, and merge it with the change it explains.

**Status of this set.** ADRs 0001-0009 were written on 2026-10-10 **retrospectively**, recording decisions already built into the code. They describe what is true of the code today; they have not yet been reviewed by the people who must approve them. Until an approver records their name and date in a record's `Approved by` line, treat it as "documented, not yet ratified".

| # | Decision |
|---|---|
| [0001](0001-playwright-as-the-single-runner.md) | Playwright Test is the single runner for web, API and desktop systems |
| [0002](0002-shared-code-as-versioned-packages.md) | Shared code is distributed as versioned packages |
| [0003](0003-adapter-contract.md) | Every external system is an Adapter that logs, times and fails the same way |
| [0004](0004-correlation-id.md) | One correlation id travels through every hop of a test |
| [0005](0005-no-hard-waits.md) | No hard waits: waiting is built in and lint-enforced |
| [0006](0006-shared-playwright-config.md) | One shared Playwright config and one Playwright version |
| [0007](0007-secrets.md) | Secrets are never in code and never stored beside their key |
| [0008](0008-sap-gui-transport.md) | SAP GUI: a transport seam, PowerShell by default, a Java/JACOB fallback |
| [0009](0009-security-gates.md) | Security gates in CI: dependency audit with expiring exceptions, and secret scanning |
