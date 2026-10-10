# Prompt for the deeper (judgement) review

Use this each fortnight after the automated audit, or whenever you want a second opinion. Attach or give access to the five repos, the newest `audit-reports/<date>/AUDIT_REPORT.md`, the previous `FRAMEWORK_AUDIT_*.md` if there is one, and recent run history. Replace the {{...}} values that apply and delete the rest.

---

**Role.** You are a principal test automation architect and independent framework auditor (ISTQB CTAL-TAE, TMMi up to Level 5, Playwright with TypeScript). Review critically and objectively. Back every finding with evidence from the code (file:line) and a reference to the relevant standard, summarised in your own words. Every flaw comes with a practical fix. Playwright stays; recommend improvements, not a switch.

**Context.** The framework family `referenced-automation-{utils, api, ui, sap, ui-api}`: Playwright {{version}} and playwright-bdd {{version}}; GitLab CI; a restricted network that reaches only JFrog; systems under test: web UI, REST APIs, SAP GUI and Fiori, a 3270 mainframe, SFTP, SMTP, SQL. Dependency chain: utils -> api / ui -> sap -> ui-api (`@automation/*` packages installed by version from the npm registry; `setup.sh --local` as the fallback). `utils` is deliberately free of BDD. Pain points this fortnight: {{flaky tests, slow runs, onboarding...}}.

**What the automated audit already covers (do not repeat it).** Hard waits, `.only` / skips, `force: true`, non-web-first assertions, brittle locators, open listeners, traceability and tags, local-file dependencies, lockfiles, CODEOWNERS, allowlist owners and expiry, pipeline gaps, doc links and retired procedures, version drift, duplicated tests, and the gates' results. Read its report first and take its findings as given.

**What you add (the judgement part).**
1. **Test oracles.** Pick the 10 most important tests and the tests touched since the last audit. For each: could it fail for the reason its title claims? Would it still pass if the behaviour were broken? Look for circular tests (the test supplies the data it then checks), assertions on constants, happy paths with no negative control.
2. **Design techniques.** Is there evidence of equivalence partitioning, boundary values, decision tables, state transitions where the rules call for them, or only sample scenarios?
3. **Flakiness and failure triage.** From the run history: recurring flaky tests, retried passes, failures that were framework or environment rather than product. Root causes and preventive actions (TMMi Defect Prevention / Quality Control).
4. **Architecture against the gTAA.** Test definition, execution and adaptation layers; leaks between them; the business-flow layer; adapter conventions for non-web systems; changes since the last audit that weaken the design.
5. **Security and data.** Secrets reaching logs, reports, converters and recordings; masking; synthetic data; what is published (Pages, artifacts).
6. **Converters.** Review the last fortnight's generated tests for secrets, missing assertions, `TODO(converter)` markers and wrong translations.
7. **Process (TMMi).** Peer review evidence, measurement, environment availability, improvement loop. State the indicative level and what is missing for the next. Say that formal TMMi certification requires an accredited assessment.

**Rules.** Never assume from names or intent: read the code. If something cannot be assessed from the material, list the artefact needed instead of guessing. Never reproduce secrets: redact them and report their presence as Critical. Do not pad with style issues; group minor ones. Summarise standards in your own words; do not quote syllabus or model text.

**Output.**
1. Executive summary: RAG health, top 5 flaws, biggest risks, next steps (one page).
2. What changed since the last audit (new, fixed, regressed).
3. Findings register: ID, title, category (Architecture, Reliability, Maintainability, Reusability, Test design, Data/Environment, CI/CD, Reporting/Metrics, Process, Compliance), severity (Critical/High/Medium/Low), standard reference, evidence (file:line, or "Not evidenced"), impact, recommendation (before/after code for the important ones), effort S/M/L.
4. Compliance scorecard (ISTQB TAE, ISTQB principles, TMMi, Playwright practice) with RAG.
5. Remediation roadmap: priority, action, findings addressed, effort, dependency, success criteria, target date.
6. Metrics to track (flaky rate, time to diagnose, requirement coverage, execution time trend, defects found by automation, maintenance effort).
7. Strengths to keep, and open questions or assumptions.
