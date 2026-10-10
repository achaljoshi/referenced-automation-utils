#!/usr/bin/env node
import * as path from 'node:path';
import { loadAllow, RULES, scanDirectory } from '../governance/secretScan';
import { parseFlags, runCli } from './args';

const USAGE = `automation-scan-secrets - fail the build if a secret is about to be committed

  automation-scan-secrets [--dir .] [--allow .secretscan-allow.json]

Scans the files git tracks (all of them, wherever they are) and untracked, not-ignored files (except in generated
directories such as node_modules or dist) for: private keys, cloud and CI tokens, JWTs, Authorization headers, passwords
in URLs and connection strings, literal passwords/secrets/keys assigned in code, JSON and unquoted YAML/properties/shell
values, secrets in Gherkin steps, secret values in committed .env files, and passwords typed into SAP GUI recordings
(.vbs). It never prints a secret - excerpts are masked, every occurrence of it. The summary says how many files were
skipped (generated directories, binary, over 1 MB, unreadable). Exit 1 if anything is found.

An intentional exception goes in .secretscan-allow.json, with a reason a reviewer can judge:
  { "allow": [ { "rule": "env-secret", "path": ".env.simulator", "reason": "the simulator's made-up credentials" } ] }
Rules: ${[...new Set(RULES.map((r) => r.id))].join(', ')}
`;

function main(): void {
  const flags = parseFlags(process.argv.slice(2).filter((a) => a !== '-h'), {
    '--dir': 'string',
    '--allow': 'string',
    '--help': 'boolean',
  });
  if (flags['--help'] || process.argv.includes('-h')) return void process.stdout.write(USAGE);
  const root = path.resolve((flags['--dir'] as string | undefined) ?? '.');
  const result = scanDirectory(
    root,
    loadAllow(path.resolve(root, (flags['--allow'] as string | undefined) ?? '.secretscan-allow.json')),
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
  const { generated, binary, tooLarge, unreadable } = result.skipped;
  process.stdout.write(
    `not scanned: ${generated} in generated directories, ${binary} binary, ${tooLarge} over 1 MB, ${unreadable} unreadable.\n`,
  );
  if (result.findings.length > 0) {
    process.stderr.write(
      'Remove the secret (and rotate it - it is in the history if it was committed), or add a reasoned exception to .secretscan-allow.json.\n',
    );
    process.exit(1);
  }
}
runCli(USAGE, main);
