#!/usr/bin/env bash
# ============================================================================
# One-shot setup: installs this repo's dependencies. This package never drives a real browser, so there is no `playwright install` step here.
#
# Dependencies are installed from the npm registry in NPM_REGISTRY_URL (the lockfile pins the versions).
#
# Usage: ./scripts/setup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# Every npm command below fetches packages from this registry.
if [ -n "${NPM_REGISTRY_URL:-}" ]; then
  npm config set registry "$NPM_REGISTRY_URL"
else
  echo "NOTE: NPM_REGISTRY_URL is not set - npm keeps using the registry it is already configured with ($(npm config get registry))."
fi

# Fail early, with the fix, if Node does not trust the HTTPS certificate of the registry - usually a company proxy that
# re-signs HTTPS. The fix is NODE_EXTRA_CA_CERTS, never NODE_TLS_REJECT_UNAUTHORIZED=0 (scripts/check-tls.js explains).
node scripts/check-tls.js || exit 1

echo ""
echo "== Installing dependencies ============================================"
npm ci

echo ""
echo "Setup complete. Try: npm test"
