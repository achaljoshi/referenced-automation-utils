#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  AllowlistError,
  AuditShapeError,
  evaluate,
  formatGate,
  loadAllowlist,
  parseAudit,
  type Severity,
} from '../governance/auditGate';
import { howToRun, parseFlags, runCli } from './args';

const USAGE = `automation-audit-gate - fail the build on dependency vulnerabilities, with exceptions that are explicit, owned and expiring

  automation-audit-gate [--level high] [--allowlist audit-allowlist.json] [--omit-dev] [--input audit.json]
                        [--strict-allowlist] [--allow-unassigned] [--max-expiry-days 366]

Runs \`npm audit --json\` (or reads --input) and fails on any advisory at or above --level (default high) that is not
covered by an unexpired entry in the allowlist.

Exit codes:  0  passed
             1  the gate failed: a blocking advisory, an allowlist that breaks the rules, or an audit report this tool
                does not understand (it fails closed - an odd report is never read as "no findings")
             2  the audit could not run (offline, no registry, npm missing) or the command line is wrong

Allowlist (audit-allowlist.json):
  { "allow": [ { "id": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "why this is acceptable",
                 "owner": "team or person", "expires": "2027-03-31" } ] }
Every entry needs id, package, reason, a real owner and an expiry no more than --max-expiry-days (default 366) away.
An entry stops protecting you on its expiry date, so the risk has to be re-decided on purpose. --strict-allowlist also
fails on entries that match nothing any more. --allow-unassigned accepts entries whose owner is empty or UNASSIGNED
(a stop-gap while an owner is being named).
${howToRun('automation-audit-gate', 'audit-gate', 'auditGate')}`;

const LEVELS: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

function main(): void {
  const flags = parseFlags(process.argv.slice(2).filter((a) => a !== '-h'), {
    '--level': 'string',
    '--allowlist': 'string',
    '--omit-dev': 'boolean',
    '--input': 'string',
    '--strict-allowlist': 'boolean',
    '--allow-unassigned': 'boolean',
    '--max-expiry-days': 'int',
    '--help': 'boolean',
  });
  if (flags['--help'] || process.argv.includes('-h')) return void process.stdout.write(USAGE);
  const threshold = (flags['--level'] as string | undefined) ?? 'high';
  if (!LEVELS.includes(threshold as Severity))
    return fail2(`--level must be one of ${LEVELS.join(', ')} (got "${threshold}")`);

  let allowlist;
  try {
    allowlist = loadAllowlist((flags['--allowlist'] as string | undefined) ?? 'audit-allowlist.json', {
      allowUnassigned: Boolean(flags['--allow-unassigned']),
      maxExpiryDays: flags['--max-expiry-days'] as number | undefined,
    });
  } catch (error) {
    if (error instanceof AllowlistError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  let text: string;
  const input = flags['--input'] as string | undefined;
  if (input) {
    try {
      text = fs.readFileSync(input, 'utf8');
    } catch (error) {
      return fail2(`could not read ${input}: ${(error as Error).message}`);
    }
  } else {
    const run = spawnSync('npm', ['audit', '--json', ...(flags['--omit-dev'] ? ['--omit=dev'] : [])], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
    // npm exits non-zero when it finds vulnerabilities, with JSON on stdout: that is normal. No process, or nothing printed, is not.
    if (run.error) return fail2(`could not run npm audit: ${run.error.message}`);
    if (run.signal) return fail2(`npm audit was killed by ${run.signal}`);
    if (!run.stdout?.trim())
      return fail2(`npm audit printed nothing (exit ${run.status})${run.stderr ? `: ${run.stderr.slice(0, 300)}` : ''}`);
    text = run.stdout;
  }

  let audit: { error?: { summary?: string; code?: string } };
  try {
    audit = JSON.parse(text);
  } catch {
    return fail2(`could not read the npm audit output - is the registry reachable?\n${text.slice(0, 300)}`);
  }
  if (audit && typeof audit === 'object' && audit.error)
    return fail2(`npm audit failed: ${audit.error.summary ?? audit.error.code ?? 'unknown error'}`);

  let advisories;
  try {
    advisories = parseAudit(audit);
  } catch (error) {
    if (error instanceof AuditShapeError) {
      process.stderr.write(`${error.message} - failing closed.\n`);
      process.exit(1);
    }
    throw error;
  }
  const result = evaluate(advisories, allowlist, { threshold: threshold as Severity });
  process.stdout.write(`${formatGate(result, threshold as Severity)}\n`);
  const staleFails = flags['--strict-allowlist'] && result.unused.length > 0;
  if (result.blocking.length > 0 || staleFails) process.exit(1);
}

function fail2(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

runCli(USAGE, main);
