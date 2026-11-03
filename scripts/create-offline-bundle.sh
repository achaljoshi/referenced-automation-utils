#!/usr/bin/env bash
# ============================================================================
# Builds an OFFLINE BUNDLE of the whole family as plain files, for a machine that can reach neither GitHub nor a registry
# that has these packages yet (for example an AWS WorkSpace that reaches only the organisation's npm registry):
#
#   <output-dir>/packages/automation-referenced-automation-<name>-<version>.tgz   utils, api, ui, sap, sas - the exact files
#                                                                                 `npm publish` uploads
#   <output-dir>/repos/referenced-automation-<name>.tar.gz                        all six repos (utils, api, ui, sap, sas,
#                                                                                 ui-api): the source, tests and docs
#   <output-dir>/SHA256SUMS.txt                                                   checksums of every file above
#   <output-dir>/README.md                                                        how to use the bundle (docs/OFFLINE_BUNDLE.md)
#
# The bundle is made from what is COMMITTED in each repo (git archive), in a clean temporary folder, so it holds neither
# uncommitted edits nor node_modules and your own working folders are not touched. The packages are built the way
# `create-package.sh --local` always builds them, in dependency order.
#
# The six repos must be checked out next to this one (referenced-automation-<name>) with nothing uncommitted.
# Needs: git, tar, node/npm and access to the npm registry npm is configured with (the packages' own third-party dependencies
# are installed once for the build).
#
# Usage: ./scripts/create-offline-bundle.sh [output-dir]      default ../offline-bundle
# Runs on macOS, Linux and Git Bash; on Windows run it from Git Bash.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FAMILY_DIR="$(cd .. && pwd)"
OUT_DIR="${1:-../offline-bundle}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

REPOS=(utils api ui sap sas ui-api)       # every repo goes into the bundle as source
PACKAGES=(utils api ui sap sas)           # the ones that are packages, in dependency order

# Every npm command below fetches packages from this registry.
if [ -n "${NPM_REGISTRY_URL:-}" ]; then
  npm config set registry "$NPM_REGISTRY_URL"
fi

for name in "${REPOS[@]}"; do
  repo="$FAMILY_DIR/referenced-automation-$name"
  if [ ! -d "$repo/.git" ]; then
    echo "ERROR: referenced-automation-$name is not checked out at $repo." >&2
    exit 1
  fi
  if [ -n "$(git -C "$repo" status --porcelain)" ]; then
    echo "ERROR: referenced-automation-$name has uncommitted changes. The bundle holds committed work only - commit or stash first." >&2
    exit 1
  fi
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/shared-packages" "$OUT_DIR/packages" "$OUT_DIR/repos"
rm -f "$OUT_DIR"/packages/*.tgz "$OUT_DIR"/repos/*.tar.gz "$OUT_DIR/SHA256SUMS.txt"

echo "== Archiving the repos (committed state) =="
for name in "${REPOS[@]}"; do
  repo="$FAMILY_DIR/referenced-automation-$name"
  echo "   referenced-automation-$name @ $(git -C "$repo" rev-parse --short HEAD)"
  git -C "$repo" archive --format=tar --prefix="referenced-automation-$name/" HEAD | tar -x -C "$WORK_DIR"
  git -C "$repo" archive --format=tar.gz --prefix="referenced-automation-$name/" -o "$OUT_DIR/repos/referenced-automation-$name.tar.gz" HEAD
done

for name in "${PACKAGES[@]}"; do
  echo ""
  echo "== Building the package referenced-automation-$name =="
  ( cd "$WORK_DIR/referenced-automation-$name" && ./scripts/create-package.sh --local ../shared-packages )
done
cp "$WORK_DIR"/shared-packages/*.tgz "$OUT_DIR/packages/"

cp docs/OFFLINE_BUNDLE.md "$OUT_DIR/README.md"

if command -v sha256sum > /dev/null 2>&1; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
( cd "$OUT_DIR" && $SUM packages/*.tgz repos/*.tar.gz > SHA256SUMS.txt )

echo ""
echo "== Offline bundle written to $OUT_DIR =="
ls -1 "$OUT_DIR/packages" "$OUT_DIR/repos"
echo ""
echo "Next: copy that folder to the other machine and follow its README.md (docs/OFFLINE_BUNDLE.md)."
