# 0002. Shared code is distributed as versioned packages

- **Status:** Accepted for the interim (tarballs); the target (an internal npm registry) is pending the platform team
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
Five repos share code (`utils` -> `api`/`ui` -> `sap` -> `ui-api`). The network reaches only the organisation's Artifactory; there is no internal npm registry set up for these packages yet.

## Decision
Each shared repo builds an npm tarball (`scripts/create-package.sh`) into `../shared-packages/`, and consumers depend on it with `file:`. The CI pipelines clone and package the dependencies the same way. Semantic versioning applies to the packages from the start (see `docs/governance/RELEASING.md`), so moving to a registry changes where they come from, not how they are versioned.

## Consequences
Works offline and in CI with no registry. Costs: a consumer must reinstall the tarball after a change (and must not delete its lockfile), and there is no central view of who uses which version. Publishing to a registry needs the platform team (registry URL and credentials are CI variables); nothing in the repos publishes anywhere.

## Alternatives considered
A monorepo (one pipeline, but the repos are separately owned and released); git dependencies (no versioning, slow, needs repo access in every install); publishing to Artifactory now (needs platform decisions we do not control).
