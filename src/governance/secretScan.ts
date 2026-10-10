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

/**
 * Values that are obviously not secrets. Anchored: a value is a placeholder if it IS one of the filler words
 * (`true`, `null`, `password`, ...), is a template/environment reference (`${X}`, `<token>`, `{{x}}`, `process.env.X`),
 * or STARTS with a placeholder word followed by a word boundary (`changeme-please`, `example.com`). A value that merely
 * begins with the same letters (`trueblue-Zk39s...`, `nullable-9f2a...`) is not skipped.
 */
const PLACEHOLDER_WHOLE =
  /^(?:true|false|null|nil|none|undefined|string|value|secret|password|passwd|pass|token|redacted|\[redacted\]|dummy|test|x{4,}|\.{3,}|-+|~)[,;)]*$/i;
const PLACEHOLDER_TEMPLATE =
  /^(?:\$\{|\$\(|\$[A-Za-z_]\w*$|<[^>]*>|%[^%\s]+%|\{\{|\*{3,}|process\.env|import\.meta\.env|os\.environ|System\.getenv|getenv|env\.[A-Za-z_])/i;
const PLACEHOLDER_PREFIX =
  /^(?:(?:changeme|change[-_ ]me|example|placeholder|replace|todo|fixme|dummy|fake|sample|wrong|invalid|incorrect|not[-_]a[-_]real|insert|xxx+)(?![a-z0-9])|not[-_]the[-_]|your[-_ ])/i;

/** Not secrets either: a file path (a package.json `bin` entry named `...-secret`) and an environment variable NAME. */
const PATH_LIKE = /^(?:\.{0,2}\/[\w./@-]+|[\w./@-]+\.(?:js|mjs|cjs|ts|json))$/;
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

export function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["'`]|["'`]$/g, '');
  return (
    v === '' ||
    PLACEHOLDER_WHOLE.test(v) ||
    PLACEHOLDER_TEMPLATE.test(v) ||
    PLACEHOLDER_PREFIX.test(v) ||
    PATH_LIKE.test(v) ||
    ENV_NAME.test(v)
  );
}

/** The words that make a key name a secret's name (the key must END with one, so `secretName` and `tokenUrl` are not). */
const KEY_NAME_END = '[\\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|passphrase)';
const CONFIG_FILES =
  /\.(?:ya?ml|properties|ini|cfg|conf|toml|sh|bash|zsh|ps1|bat|cmd|tf|tfvars|gradle)$|(?:^|\/)Dockerfile[^/]*$/i;
const PROSE_FILES = /\.(md|markdown|txt|rst)$/i;
const CONNECTION_SCHEMES =
  '(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|rediss?|amqps?|mssql|sqlserver|oracle|ftps?|sftp|smtps?|imaps?|ldaps?|ssh|jdbc:[a-z0-9]+|[a-z][a-z0-9+.-]*)';

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
    exclude: PROSE_FILES,
  },
  {
    id: 'json-secret',
    description: 'a literal value for a "password" / "secret" / "token" / "key" property in JSON',
    pattern: new RegExp(`["']${KEY_NAME_END}["']\\s*:\\s*["']([^"'\\s]{6,})["']`, 'i'),
    exclude: PROSE_FILES,
  },
  {
    id: 'unquoted-secret',
    description:
      'an unquoted password / secret / token value in a YAML, properties, shell, Docker or similar config file',
    pattern: new RegExp(`^\\s*(?:export\\s+|set\\s+|ENV\\s+|-\\s+)?["']?${KEY_NAME_END}["']?\\s*[:=]\\s*([^\\s"'#<$\\[{!%][^\\s#]{5,})`, 'i'),
    files: CONFIG_FILES,
  },
  {
    id: 'authorization-header',
    description: 'a Bearer / Basic / token credential in an Authorization header (including curl -H)',
    pattern: /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{8,})/i,
  },
  {
    id: 'curl-credentials',
    description: 'user:password given to curl with -u / --user',
    pattern: /\bcurl\b[^\n]*?\s(?:-u|--user)[\s=]+["']?[^\s:"']+:([^\s"']{4,})/i,
  },
  {
    id: 'jwt',
    description: 'a JSON Web Token',
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/,
  },
  {
    id: 'connection-string',
    description: 'a password inside a connection string (postgres://user:pass@host, Server=...;Password=...)',
    pattern: new RegExp(`\\b(?!https?:)${CONNECTION_SCHEMES}://[^/\\s:@'"]+:([^/\\s:@'"]{3,})@`, 'i'),
  },
  {
    id: 'connection-string',
    description: 'a password inside a connection string (postgres://user:pass@host, Server=...;Password=...)',
    pattern: /\b(?:server|data source|host)=[^;\n]*;[^\n]*?\b(?:password|pwd)=([^;'"\s]{4,})/i,
  },
  {
    id: 'feature-secret',
    description: 'a literal password / secret / token in a Gherkin step (use {{env:NAME}})',
    // The value's opening quote follows whitespace; the closing quote of a label ("Password" with ...) does not, so a
    // label is never mistaken for the value.
    pattern: /\b(?:password|passwd|passphrase|secret|token|api[ _-]?key)\b["']?[^"'\n]*(?<=\s)["']([^"']{6,})["']/i,
    files: /\.feature$/i,
  },
  {
    id: 'feature-secret',
    description: 'a literal password / secret / token in a Gherkin step (use {{env:NAME}})',
    pattern: /(?<=^|\s)["']([^"']{6,})["'][^"'\n]*\b(?:password|passwd|passphrase|secret|token|api[ _-]?key)\b/i,
    files: /\.feature$/i,
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

function maskedSecret(secret: string): string {
  return secret.length >= 8 ? `${secret.slice(0, 2)}***` : '***';
}

/** The line with EVERY occurrence of every given secret masked (longest first, so one secret containing another is masked whole). */
function mask(line: string, secrets: Iterable<string>): string {
  let shown = line;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((x, y) => y.length - x.length))
    shown = shown.split(secret).join(maskedSecret(secret));
  return shown.trim().slice(0, 140);
}

export interface FileList {
  /** What will be scanned. */
  files: string[];
  /** Untracked files inside generated directories (node_modules, dist, test-results, ...) that were left out. */
  skipped: string[];
}

function walkAll(root: string, dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir.split(path.sep).join('/'), e.name);
    return e.isDirectory() ? walkAll(root, rel) : [rel];
  });
}

/**
 * Files to look at, and the ones deliberately left out.
 *
 * In a git checkout: EVERY tracked file (a secret committed under `node_modules/` or `logs/` is still in the history,
 * so being in a "generated" directory does not exempt a tracked file), plus untracked, not-ignored files except those
 * in generated directories (listed in `skipped`, so the output can say how much was not looked at). Without git: a
 * directory walk that does not enter the generated directories and counts what is inside them as skipped.
 */
export function listFiles(root: string): FileList {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (tracked.status === 0) {
    const others = spawnSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const split = (out: string) => out.split('\0').filter(Boolean);
    const untracked = others.status === 0 ? split(others.stdout) : [];
    return {
      files: [...split(tracked.stdout), ...untracked.filter((n) => !SKIP_DIRS.test(n))],
      skipped: untracked.filter((n) => SKIP_DIRS.test(n)),
    };
  }
  const files: string[] = [];
  const skipped: string[] = [];
  (function walk(dir: string): void {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir.split(path.sep).join('/'), e.name).replace(/^\.\//, '');
      if (!e.isDirectory()) files.push(rel);
      else if (SKIP_DIRS.test(`${rel}/`)) skipped.push(...walkAll(root, rel).map((n) => n.replace(/^\.\//, '')));
      else walk(rel);
    }
  })('.');
  return { files, skipped };
}

/** Files to look at: see `listFiles`. */
export function filesToScan(root: string): string[] {
  return listFiles(root).files;
}

const globalFlavour = new WeakMap<RegExp, RegExp>();
function everyMatch(pattern: RegExp, line: string): RegExpMatchArray[] {
  let global = globalFlavour.get(pattern);
  if (!global) {
    global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    globalFlavour.set(pattern, global);
  }
  return [...line.matchAll(global)];
}

export function scanFile(file: string, text: string, rules: Rule[] = RULES): Finding[] {
  const lines = text.split(/\r?\n/);
  const hits: Array<{ rule: string; line: number }> = [];
  const secretsByLine = new Map<number, Set<string>>();
  for (const rule of rules) {
    if (rule.files && !rule.files.test(file)) continue;
    if (rule.exclude?.test(file)) continue;
    lines.forEach((line, index) => {
      let hit = false;
      for (const match of everyMatch(rule.pattern, line)) {
        const secret = match[1];
        if (secret !== undefined && isPlaceholder(secret)) continue;
        hit = true;
        if (secret) {
          if (!secretsByLine.has(index)) secretsByLine.set(index, new Set());
          secretsByLine.get(index)?.add(secret);
        }
      }
      if (hit && !hits.some((h) => h.rule === rule.id && h.line === index)) hits.push({ rule: rule.id, line: index });
    });
  }
  // Every excerpt of a line masks every secret found on it - by any rule, however many times it appears.
  return hits
    .sort((x, y) => x.line - y.line)
    .map((h) => ({
      rule: h.rule,
      file,
      line: h.line + 1,
      excerpt: mask(lines[h.line] ?? '', secretsByLine.get(h.line) ?? []),
    }));
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
  /** What was NOT looked at, so a clean result is not read as "everything was checked". */
  skipped: { generated: number; binary: number; tooLarge: number; unreadable: number };
}

export function scanDirectory(root: string, allow: AllowRule[] = []): ScanResult {
  const all: Finding[] = [];
  const texts = new Map<string, string[]>();
  let scanned = 0;
  const listing = listFiles(root);
  const skipped = { generated: listing.skipped.length, binary: 0, tooLarge: 0, unreadable: 0 };
  for (const file of listing.files) {
    const full = path.join(root, file);
    let buffer: Buffer;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        skipped.unreadable++;
        continue;
      }
      if (stat.size > MAX_BYTES) {
        skipped.tooLarge++;
        continue;
      }
      buffer = fs.readFileSync(full);
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (isBinary(buffer)) {
      skipped.binary++;
      continue;
    }
    scanned++;
    const text = buffer.toString('utf8');
    const found = scanFile(file, text);
    if (found.length) {
      texts.set(file, text.split(/\r?\n/));
      all.push(...found);
    }
  }
  const { remaining, allowed } = applyAllowlist(all, allow, texts);
  return { scanned, findings: remaining, allowed, skipped };
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
