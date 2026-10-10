#!/usr/bin/env node
import * as path from 'node:path';
import {
  auditFamily,
  compareReports,
  discoverFamily,
  findPreviousReport,
  AUDIT_SEVERITIES,
  auditSeverityCounts,
  worstAuditSeverity,
  writeAuditReport,
  allFindings,
  type RepoRef,
  type AuditSeverity,
} from '../governance/frameworkAudit';

const USAGE = `automation-framework-audit - the fortnightly framework audit, the automated part

  automation-framework-audit [--repo <dir>]... [--family <parent-dir>] [--out audit-reports] [--run]
                             [--fail-on critical|high|medium|low] [--quiet]

  --repo <dir>     Audit this repo (repeatable). Default: the current directory.
  --family <dir>   Audit every referenced-automation-* repo found in <dir>; adds the checks that compare repos
                   (Playwright / playwright-bdd versions, duplicated tests).
  --out <dir>      Where reports go: <dir>/<date>/AUDIT_REPORT.md and audit.json. Default: audit-reports.
                   The newest earlier report in <dir> is compared with this one ("since the previous audit").
  --run            Also run lint, typecheck, test and security in each repo and report the outcome (slow).
  --fail-on <sev>  Exit 1 when any finding is at or above this severity. Default: never fail (manual trigger).

What it checks: hard waits, test.only / skips, force: true, non-web-first assertions, brittle locators, servers
listening on all interfaces, requirement traceability and tags, local-file @automation dependencies, lockfile,
playwright-bdd pinning, CODEOWNERS, accepted-advisory owners and expiry, pipeline gaps (non-blocking security job,
no typecheck, features never generated, image/doc mismatches), broken doc links and retired procedures, version drift
and duplicated tests across repos. Exceptions go in .framework-audit.json with a reason; see docs/governance/AUDIT.md.
It never needs a network. The judgement-based review is the checklist at the end of the report.
`;

function values(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1] as string);
  });
  return out;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
} else {
  const failOn = values('--fail-on')[0];
  if (failOn && !AUDIT_SEVERITIES.includes(failOn as AuditSeverity)) {
    process.stderr.write(`--fail-on must be one of ${AUDIT_SEVERITIES.join(', ')}\n\n${USAGE}`);
    process.exit(2);
  }
  const family = values('--family')[0];
  let repos: RepoRef[];
  if (family) {
    repos = discoverFamily(path.resolve(family));
    if (repos.length === 0) {
      process.stderr.write(`no referenced-automation-* repos found in ${family}\n`);
      process.exit(2);
    }
  } else {
    const dirs = values('--repo');
    repos = (dirs.length > 0 ? dirs : ['.']).map((d) => ({ name: path.basename(path.resolve(d)), dir: d }));
  }
  const outDir = path.resolve(values('--out')[0] ?? 'audit-reports');
  const report = auditFamily({ repos, run: process.argv.includes('--run') });
  const delta = compareReports(findPreviousReport(outDir, report.generatedAt.slice(0, 10)), report);
  const written = writeAuditReport(report, outDir, delta);
  const all = allFindings(report);
  const counts = auditSeverityCounts(all);
  if (!process.argv.includes('--quiet')) {
    for (const r of report.repos) {
      const c = auditSeverityCounts(r.findings);
      process.stdout.write(`${r.repo}: ${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low, ${c.info} info\n`);
    }
    if (report.family.length > 0) process.stdout.write(`across repos: ${report.family.length} finding(s)\n`);
    if (delta) process.stdout.write(`since the previous audit: ${delta.added.length} new, ${delta.resolved.length} resolved, ${delta.persisting} still open\n`);
  }
  process.stdout.write(`\nreport: ${written.markdown}\n`);
  process.stdout.write(`total: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info\n`);
  if (failOn) {
    const worst = worstAuditSeverity(all);
    if (worst && AUDIT_SEVERITIES.indexOf(worst) <= AUDIT_SEVERITIES.indexOf(failOn as AuditSeverity)) {
      process.stderr.write(`audit failed: found ${worst} (limit ${failOn})\n`);
      process.exit(1);
    }
  }
}
