#!/usr/bin/env node
import * as path from 'node:path';
import { loadAllow, RULES, scanDirectory } from '../governance/secretScan';

const USAGE = `automation-scan-secrets - fail the build if a secret is about to be committed

  automation-scan-secrets [--dir .] [--allow .secretscan-allow.json]

Scans the files git tracks (and untracked, not-ignored files) for: private keys, cloud and CI tokens, passwords in URLs,
literal passwords/secrets/keys assigned in code, secret values in committed .env files, and passwords typed into SAP GUI
recordings (.vbs). It never prints a secret - excerpts are masked. Exit 1 if anything is found.

An intentional exception goes in .secretscan-allow.json, with a reason a reviewer can judge:
  { "allow": [ { "rule": "env-secret", "path": ".env.simulator", "reason": "the simulator's made-up credentials" } ] }
Rules: ${RULES.map((r) => r.id).join(', ')}
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
} else {
  const root = path.resolve(arg('--dir') ?? '.');
  const result = scanDirectory(
    root,
    loadAllow(path.resolve(root, arg('--allow') ?? '.secretscan-allow.json')),
  );
  for (const f of result.findings)
    process.stdout.write(`${f.file}:${f.line}  ${f.rule}\n    ${f.excerpt}\n`);
  for (const { finding, reason } of result.allowed)
    process.stdout.write(
      `allowed  ${finding.file}:${finding.line}  ${finding.rule}  (${reason})\n`,
    );
  process.stdout.write(
    `\nscanned ${result.scanned} file(s): ${result.findings.length} finding(s), ${result.allowed.length} allowed.\n`,
  );
  if (result.findings.length > 0) {
    process.stderr.write(
      'Remove the secret (and rotate it - it is in the history if it was committed), or add a reasoned exception to .secretscan-allow.json.\n',
    );
    process.exit(1);
  }
}
