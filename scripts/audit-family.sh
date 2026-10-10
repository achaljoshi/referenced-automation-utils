#!/usr/bin/env bash
# ============================================================================
# The fortnightly framework audit over all five repos (they must be checked out next to each other).
#
#   ./scripts/audit-family.sh            automated checks only, a few seconds
#   ./scripts/audit-family.sh --run      also runs lint, typecheck, test and security in every repo (slow)
#
# The report is written to ../audit-reports/<date>/AUDIT_REPORT.md. Keep that folder between audits: the next run
# compares with the newest earlier report. Everything it checks, and how to accept a finding on purpose: see
# docs/governance/AUDIT.md.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/cli/frameworkAudit.js ] || npm run build
node dist/cli/frameworkAudit.js --family .. --out ../audit-reports "$@"
