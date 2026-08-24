#!/usr/bin/env bash
# ============================================================================
# One-shot local setup: installs dependencies. This package never drives a
# real browser (no `page`/`browser` fixtures are used), so unlike the ui/api
# repos there is no `playwright install` step here.
#
# Usage: ./scripts/setup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Installing dependencies =========================================="
npm ci

echo ""
echo "Setup complete. Try: npm test"
