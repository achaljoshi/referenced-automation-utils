import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Rule {
  id: string;
  description: string;
  /** Matches one line. Group 1 (if any) is the secret value, used for the placeholder check and the masked excerpt. */
  pattern: RegExp;
  /** Limit the rule to files whose path matches. */
  files?: RegExp;
  /** Skip files whose path matches (the fuzzy generic rule skips prose: Markdown is full of `secret: \`example\``). */
  exclude?: RegExp;
}

export interface Finding {
  rule: string;
  file: string;
  line: number;
  /** The offending line with the secret masked - the scanner never prints a secret. */
  excerpt: string;
}

export interface AllowRule {
  rule: string;
  /** Path (exact, or a prefix ending in /) the exception applies to. */
  path: string;
  /** Narrow to lines matching this regex. */
  match?: string;
  reason: string;
}

/** Values that are obviously not secrets: placeholders, environment reads, templates, empty. */
const PLACEHOLDER =
  /^(\$\{|\$\(|<|%|process\.env|env\.|changeme|change-me|example|placeholder|your[-_ ]|xxx|\*{3,}|replace|todo|null|undefined|true|false)/i;

export const RULES: Rule[] = [
  {
    id: 'private-key',
    description: 'a private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { id: 'aws-access-key', description: 'an AWS access key id', pattern: /\b(AKIA[0-9A-Z]{16})\b/ },
  {
    id: 'github-token',
    description: 'a GitHub token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/,
  },
  { id: 'gitlab-token', description: 'a GitLab token', pattern: /\b(glpat-[A-Za-z0-9_-]{20,})\b/ },
  {
    id: 'slack-token',
    description: 'a Slack token',
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    id: 'url-credentials',
    description: 'a password inside a URL',
    pattern: /\bhttps?:\/\/[^/\s:@'"]+:([^/\s:@'"]{3,})@/,
  },
  {
    id: 'password-assignment',
    description: 'a literal value assigned to a password / secret / token / key',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\w*\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i,
    exclude: /\.(md|markdown|txt|rst)$/i,
  },
  {
    id: 'env-secret',
    description:
      'a secret value in a committed .env file (secrets belong in .env.<name>.local or CI variables)',
    pattern:
      /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*["']?([^\s"'#]{4,})/,
    files: /(^|\/)\.env(\.[^/]*)?$/,
  },
  {
    id: 'sap-recorded-password',
    description:
      'a password typed during a SAP GUI recording, in clear text (the recorder writes whatever was typed)',
    pattern: /findById\s*\(\s*"[^"]*pwd[^"]*"\s*\)\s*\.text\s*=\s*"([^"]+)"/i,
    files: /\.(vbs|vb|txt)$/i,
  },
];

const SKIP_DIRS =
  /(^|\/)(node_modules|dist|\.git|test-results|playwright-report|allure-results|allure-report|logs|\.features-gen|\.secrets)\//;
const MAX_BYTES = 1_000_000;

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 4096).includes(0);
}

function mask(line: string, secret: string | undefined): string {
  const shown = secret ? line.replace(secret, `${secret.slice(0, 2)}***`) : line;
  return shown.trim().slice(0, 140);
}

/** Files to look at: tracked and not-ignored untracked files if this is a git checkout, otherwise a directory walk. */
export function filesToScan(root: string): string[] {
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  const names =
    git.status === 0
      ? git.stdout.split('\n').filter(Boolean)
      : (function walk(dir: string): string[] {
          return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
            const rel = path.posix.join(dir.split(path.sep).join('/'), e.name);
            return e.isDirectory() ? (SKIP_DIRS.test(`${rel}/`) ? [] : walk(rel)) : [rel];
          });
        })('.').map((n) => n.replace(/^\.\//, ''));
  return names.filter((n) => !SKIP_DIRS.test(n));
}

export function scanFile(file: string, text: string, rules: Rule[] = RULES): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.files && !rule.files.test(file)) continue;
    if (rule.exclude?.test(file)) continue;
    lines.forEach((line, index) => {
      const match = rule.pattern.exec(line);
      if (!match) return;
      const secret = match[1];
      if (secret !== undefined && PLACEHOLDER.test(secret)) return;
      findings.push({ rule: rule.id, file, line: index + 1, excerpt: mask(line, secret) });
    });
  }
  return findings;
}

export function applyAllowlist(
  findings: Finding[],
  allow: AllowRule[],
  texts: Map<string, string[]>,
): { remaining: Finding[]; allowed: Array<{ finding: Finding; reason: string }> } {
  const remaining: Finding[] = [];
  const allowed: Array<{ finding: Finding; reason: string }> = [];
  for (const finding of findings) {
    const entry = allow.find(
      (a) =>
        a.rule === finding.rule &&
        (a.path === finding.file || (a.path.endsWith('/') && finding.file.startsWith(a.path))) &&
        (!a.match || new RegExp(a.match).test(texts.get(finding.file)?.[finding.line - 1] ?? '')),
    );
    if (entry) allowed.push({ finding, reason: entry.reason });
    else remaining.push(finding);
  }
  return { remaining, allowed };
}

export interface ScanResult {
  scanned: number;
  findings: Finding[];
  allowed: Array<{ finding: Finding; reason: string }>;
}

export function scanDirectory(root: string, allow: AllowRule[] = []): ScanResult {
  const all: Finding[] = [];
  const texts = new Map<string, string[]>();
  let scanned = 0;
  for (const file of filesToScan(root)) {
    const full = path.join(root, file);
    let buffer: Buffer;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      buffer = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (isBinary(buffer)) continue;
    scanned++;
    const text = buffer.toString('utf8');
    const found = scanFile(file, text);
    if (found.length) {
      texts.set(file, text.split(/\r?\n/));
      all.push(...found);
    }
  }
  const { remaining, allowed } = applyAllowlist(all, allow, texts);
  return { scanned, findings: remaining, allowed };
}

export function loadAllow(file: string): AllowRule[] {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { allow?: AllowRule[] };
  for (const a of parsed.allow ?? [])
    if (!a.rule || !a.path || !a.reason)
      throw new Error(
        `every allow entry needs "rule", "path" and "reason" (found ${JSON.stringify(a)})`,
      );
  return parsed.allow ?? [];
}
