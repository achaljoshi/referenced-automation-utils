# 0001. Playwright Test is the single runner for web, API and desktop systems

- **Status:** Accepted (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
The programme tests web UIs, REST APIs, files over SFTP, e-mail, databases, classic SAP GUI and (eventually) mainframe terminals. The previous generation used a separate Java/Selenium framework for the SAP half. Two runners mean two sets of reports, retries, tagging, CI wiring and logging, and flows that cross systems (API then SAP GUI then a database) cannot be one test.

## Decision
Playwright Test (TypeScript) is the runner for everything. Systems Playwright cannot drive itself are reached through adapters (ADR 0003) that run inside Playwright tests as fixtures; Playwright's browser is simply not used for them.

## Consequences
One runner, config, tag scheme, retry policy, reporter set, logger and CI model; cross-system flows are ordinary tests. The cost is that Playwright is not designed for desktop applications: for those we use only its runner, fixtures and `expect`, and we own the adapters. SAP GUI and 3270 tests can only run where the GUI/emulator exists (Windows for SAP GUI).

## Alternatives considered
Keep Java/JUnit for desktop systems (two stacks, no single flow); Appium/WinAppDriver for desktop (generic UI Automation instead of SAP's own scripting API, less reliable for SAP).
