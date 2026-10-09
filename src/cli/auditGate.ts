#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  evaluate,
  formatGate,
  loadAllowlist,
  parseAudit,
  type Severity,
} from '../governance/auditGate';

const USAGE = `automation-audit-gate - fail the build on dependency vulnerabilities, with exceptions that are explicit, owned and expiring

  automation-audit-gate [--level high] [--allowlist audit-allowlist.json] [--omit-dev] [--input audit.json] [--strict-allowlist]

Runs \`npm audit --json\` (or reads --input) and fails (exit 1) on any advisory at or above --level (default high) that
is not covered by an unexpired entry in the allowlist. Exit 2: the audit itself could not run (offline, no registry).

Allowlist (audit-allowlist.json):
  { "allow": [ { "id": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "why this is acceptable",
                 "owner": "team or person", "expires": "2027-03-31" } ] }
An entry stops protecting you on its expiry date, so the risk has to be re-decided on purpose. --strict-allowlist also
fails on entries that match nothing any more.
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h'))
    return void process.stdout.write(USAGE);
  const threshold = (arg('--level') ?? 'high') as Severity;
  const input = arg('--input');
  let text: string;
  if (input) text = fs.readFileSync(input, 'utf8');
  else {
    const run = spawnSync(
      'npm',
      ['audit', '--json', ...(process.argv.includes('--omit-dev') ? ['--omit=dev'] : [])],
      { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
    );
    text = run.stdout;
  }
  let audit: { error?: { summary?: string; code?: string }; vulnerabilities?: unknown };
  try {
    audit = JSON.parse(text);
  } catch {
    process.stderr.write(
      `could not read the npm audit output - is the registry reachable?\n${text.slice(0, 300)}\n`,
    );
    process.exit(2);
  }
  if (audit.error) {
    process.stderr.write(
      `npm audit failed: ${audit.error.summary ?? audit.error.code ?? 'unknown error'}\n`,
    );
    process.exit(2);
  }
  const result = evaluate(
    parseAudit(audit),
    loadAllowlist(arg('--allowlist') ?? 'audit-allowlist.json'),
    { threshold },
  );
  process.stdout.write(`${formatGate(result, threshold)}\n`);
  const staleFails = process.argv.includes('--strict-allowlist') && result.unused.length > 0;
  if (result.blocking.length > 0 || staleFails) process.exit(1);
}

main();
