# 0010. Shared packages are installed by version from the npm registry; local tarballs are the fallback

- **Status:** Accepted (supersedes [0002](0002-shared-code-as-versioned-packages.md))
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
0002 had consumers depend on `file:../shared-packages/<name>.tgz`. Upgrading meant rebuilding and reinstalling a tarball by hand, an unchanged filename could serve stale contents, the CI jobs had to clone and build sibling repos, and the lockfiles held machine-specific paths. The network reaches the organisation's Artifactory, which can host an npm registry for these packages.

## Decision
`@automation/*` dependencies are ordinary version ranges (`"^1.0.0"`) in `package.json`. Every `setup` script first runs `npm config set registry "$NPM_REGISTRY_URL"`, so `npm ci` fetches them - by the versions in the lockfile - from that registry. Upgrading is one change: the version in `package.json`, then `npm install`. A package is published once per version with `scripts/publish-package.sh` (`npm publish` of the tarball `create-package.sh` builds); the scripts never authenticate and the URL is only ever the `NPM_REGISTRY_URL` variable. When a version is not published yet, or a change should be tried first, `setup.sh --local` (or `npm install --no-save <tgz>`) installs locally built tarballs without touching `package.json` or the lockfile. The pipelines install by version and no longer clone sibling repos. The committed lockfiles carry no `resolved`/`integrity` for `@automation/*` packages; the first install against the real registry adds them.

## Consequences
Upgrading and rolling back are a one-line change with a reviewable diff; CI is simpler and identical to a developer's machine. Costs: a package must be published (in dependency order) before consumers can ask for the new version, and a registry plus publish permission is needed. Authentication to the registry stays the platform team's procedure.

## Alternatives considered
Keeping `file:` tarballs (works offline, but manual and stale-prone); git dependencies (no versioning, needs repo access in every install); a monorepo (the repos are separately owned and released).
