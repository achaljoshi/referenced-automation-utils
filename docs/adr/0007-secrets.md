# 0007. Secrets are never in code and never stored beside their key

- **Status:** Accepted (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
The previous framework kept an AES-encrypted password with its decryption key in the same properties file, which protects nothing from anyone who can read the file. SAP recordings contain whatever was typed, including passwords, in clear text.

## Decision
Secrets come from providers, in order: real environment variables (CI: masked variables), then the git-ignored `.env.<name>.local`, then (Windows) a file protected with DPAPI for the current user on the current machine (`sap-gui-secret`). The framework never stores or logs a secret; log details are redacted; the converter replaces recorded passwords with environment reads. `.env.*.local` and `.secrets/` are git-ignored; `automation-scan-secrets` (ADR 0009) fails a build that commits one.

## Consequences
No key to steal next to a ciphertext; the same code works locally and in CI. Cost: DPAPI is Windows-only and per user and machine (fine for test machines, not a shared team store); a secrets manager is the right long-term home and slots in as another provider.

## Alternatives considered
Encrypted file plus key (what existed); one shared password in the repo; prompting at run time (cannot run unattended).
