import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { loadEnv } from '../src/config/env';

/**
 * Drift guard for the configuration documentation: `.env.example` is the complete reference of every environment
 * variable this package reads, the README's "Configuration reference" table repeats it, and `.env.local.example` is the
 * template for the secrets. A variable added to the code without a line in `.env.example` (or a line left behind after
 * the code stopped reading it) fails here, so the documentation cannot rot unnoticed.
 */
const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const NAME = '[A-Z][A-Z0-9_]*';

function filesUnder(dir: string, pattern: RegExp): string[] {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), pattern) : pattern.test(entry.name) ? [path.join(dir, entry.name)] : []));
}

/** Source text without comments, so a variable that is only MENTIONED in a doc comment does not count as read. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** The variable names a piece of TypeScript reads: `env.get*('X')`, `process.env.X`, `process.env['X']` and `env.X` on an env object. */
export function keysRead(source: string): Set<string> {
  const code = stripComments(source);
  const found = new Set<string>();
  const patterns = [
    new RegExp(`\\benv\\.(?:get|getOptional|getInt|getBoolean|getList|has)\\(\\s*['"](${NAME})['"]`, 'g'),
    new RegExp(`\\bprocess\\.env\\.(${NAME})\\b`, 'g'),
    new RegExp(`\\bprocess\\.env\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
    new RegExp(`\\benv\\.(${NAME})\\b`, 'g'),
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.add(match[1] as string);
  return found;
}

/** Variables the shell scripts read: `${X:-}` in .sh, `if defined X` in .bat (minus the names the script sets itself) and the CI files' `${X:-}` / `variables:` defaults. */
export function scriptKeys(text: string, kind: 'sh' | 'bat' | 'yml'): Set<string> {
  const found = new Set<string>();
  if (kind === 'bat') {
    const local = new Set([...text.matchAll(new RegExp(`set\\s+"(${NAME})=`, 'gi'))].map((m) => (m[1] as string).toUpperCase()));
    for (const m of text.matchAll(new RegExp(`defined\\s+(${NAME})`, 'g'))) if (!local.has(m[1] as string)) found.add(m[1] as string);
    return found;
  }
  const assigned = new Set([...text.matchAll(new RegExp(`^\\s*(${NAME})=`, 'gm'))].map((m) => m[1] as string)); // the script's own variables
  for (const m of text.matchAll(new RegExp(`\\$\\{(${NAME})[:+-]`, 'g'))) if (!assigned.has(m[1] as string)) found.add(m[1] as string);
  if (kind === 'yml') {
    for (const m of text.matchAll(/^ {2}(AUTOMATION_[A-Z0-9_]+):/gm)) found.add(m[1] as string);
    for (const name of [...found]) if (name.startsWith('CI_')) found.delete(name); // GitLab's own predefined variables
  }
  return found;
}

export interface ExampleEntry {
  name: string;
  block: string[];
}

/** The variables of `.env.example`: every `# NAME=` (or `NAME=`) line, with the comment lines directly above it. */
export function parseExample(text: string): Map<string, ExampleEntry> {
  const entries = new Map<string, ExampleEntry>();
  let block: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const variable = new RegExp(`^#?\\s?(${NAME})=`).exec(line);
    if (variable) {
      entries.set(variable[1] as string, { name: variable[1] as string, block });
      block = [];
    } else if (line.startsWith('#')) block.push(line);
    else block = [];
  }
  return entries;
}

/** What is missing from a variable's comment lines: what it is for, where it is read from, the values, default / required / secret, an example. */
export function metadataProblems(entries: Map<string, ExampleEntry>): string[] {
  const problems: string[] = [];
  for (const { name, block } of entries.values()) {
    const text = block.join('\n');
    if (block.length === 0 || /^# (Read from|Values|Default|Example)/.test(block[0] as string)) problems.push(`${name}: the first comment line must say what it is for`);
    if (!/^# Read from: \S/m.test(text)) problems.push(`${name}: no "Read from:" line`);
    if (!/^# Values: \S/m.test(text)) problems.push(`${name}: no "Values:" line`);
    if (!/^# Default: \S.* \| Required: \S.* \| Secret: (?:no|YES)\b/m.test(text)) problems.push(`${name}: no "Default: ... | Required: ... | Secret: no|YES" line`);
    const example = /^# Example(?: \([^)]*\))?: (\S+?)=/m.exec(text);
    if (!example) problems.push(`${name}: no "Example: ${name}=..." line`);
    else if (example[1] !== name) problems.push(`${name}: its Example line shows ${example[1]}=`);
  }
  return problems;
}

export const isSecret = (entry: ExampleEntry): boolean => /\| Secret: YES\b/.test(entry.block.join('\n'));

/** The `Name | Purpose | Default | Required | Secret` rows of the README section: name -> is the Secret cell YES? */
export function readmeTable(readme: string, heading = '## Configuration reference'): Map<string, boolean> {
  const start = readme.indexOf(`\n${heading}\n`);
  if (start === -1) return new Map();
  const rest = readme.slice(start + heading.length + 2);
  const end = rest.search(/\n## /);
  const rows = new Map<string, boolean>();
  for (const line of (end === -1 ? rest : rest.slice(0, end)).split('\n')) {
    const row = new RegExp(`^\\|\\s*\`(${NAME})\`\\s*\\|`).exec(line);
    if (!row) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    rows.set(row[1] as string, /YES/.test(cells[cells.length - 2] as string));
  }
  return rows;
}

/** Names in `a` that are not in `b`. */
export const missingFrom = (a: Iterable<string>, b: { has(name: string): boolean }): string[] => [...a].filter((name) => !b.has(name)).sort();

// ---- what this repo reads ---------------------------------------------------------------------------------------

const srcFiles = [...filesUnder('src', /\.ts$/), 'playwright.config.ts'];
const codeKeys = new Set<string>();
for (const file of srcFiles) for (const key of keysRead(read(file))) codeKeys.add(key);
for (const file of filesUnder('scripts', /\.sh$/)) for (const key of scriptKeys(read(file), 'sh')) codeKeys.add(key);
for (const file of filesUnder('scripts', /\.bat$/)) for (const key of scriptKeys(read(file), 'bat')) codeKeys.add(key);
for (const file of ['.gitlab-ci.yml', ...filesUnder('ci', /\.yml$/)]) for (const key of scriptKeys(read(file), 'yml')) codeKeys.add(key);

/**
 * Listed in `.env.example` although no code in this repo reads them literally. Each needs a reason; the last test fails
 * when an entry here becomes unnecessary (the code started reading it) or unknown (it left the example).
 */
const PASS_THROUGH: Record<string, string> = {
  BASE_URL: 'the name is chosen by the baseUrlKey option of createPlaywrightConfig, so no literal read exists here',
  API_BASE_URL: 'the name is chosen by the baseUrlKey option of createPlaywrightConfig, so no literal read exists here',
  TZ: 'read by Node itself, from the real environment',
  SMTP_HOST: 'convention used by the README and JSDoc examples; SmtpClient takes its settings as parameters',
  SMTP_PORT: 'convention used by the README and JSDoc examples; SmtpClient takes its settings as parameters',
  SMTP_SECURE: 'convention used by the README and JSDoc examples; SmtpClient takes its settings as parameters',
  SMTP_USER: 'convention used by the README and JSDoc examples; SmtpClient takes its settings as parameters',
  SMTP_PASS: 'convention used by the README and JSDoc examples; SmtpClient takes its settings as parameters',
  SFTP_HOST: 'convention used by the README and JSDoc examples; SftpClient takes its settings as parameters',
  SFTP_USER: 'convention used by the README and JSDoc examples; SftpClient takes its settings as parameters',
  SFTP_PASSWORD: 'convention used by the README and JSDoc examples; SftpClient takes its settings as parameters',
};

const exampleText = read('.env.example');
const example = parseExample(exampleText);

test.describe('.env.example is the complete, accurate configuration reference', () => {
  test('the scan finds a sensible number of variables (so the checks below cannot pass on nothing)', () => {
    expect(srcFiles.length).toBeGreaterThan(30);
    expect(codeKeys.size).toBeGreaterThanOrEqual(45);
    for (const known of ['ENV', 'BROWSER', 'HEADLESS', 'WORKERS', 'RETRIES', 'TEST_TIMEOUT_MS', 'LOG_LEVEL', 'LOG_FILE_PER_WORKER', 'RANDOM_SEED', 'S3270_PATH', 'TN3270_TIMEOUT_MS', 'REMOTE_ENABLED', 'REMOTE_RDP_PASSWORD', 'REMOTE_DB_CONNECTION_STRING', 'CI', 'SESSIONNAME', 'NPM_REGISTRY_URL', 'AUTOMATION_MIN_EXECUTED'])
      expect(codeKeys, `the scan should find ${known}`).toContain(known);
    expect(example.size).toBeGreaterThanOrEqual(60);
    expect([...codeKeys].filter((k) => k.startsWith('REMOTE_'))).toHaveLength(21);
  });

  test('every variable the code reads is in .env.example', () => {
    expect(missingFrom(codeKeys, example)).toEqual([]);
  });

  test('.env.example lists no variable that nothing reads (except the documented pass-through ones)', () => {
    const unread = [...example.keys()].filter((name) => !codeKeys.has(name) && !(name in PASS_THROUGH)).sort();
    expect(unread).toEqual([]);
  });

  test('every pass-through entry is still needed and still documented', () => {
    for (const [name, reason] of Object.entries(PASS_THROUGH)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10);
      expect(example.has(name), `${name} is in PASS_THROUGH but not in .env.example`).toBe(true);
      expect(codeKeys.has(name), `${name} is read by the code now - remove it from PASS_THROUGH`).toBe(false);
    }
  });

  test('every variable says what it is for, where it is read from, its values, default, required, secret and an example', () => {
    expect(metadataProblems(example)).toEqual([]);
  });

  test('the quoting tip is given once, and the file explains the load order and the secret file name', () => {
    expect(exampleText.match(/TIP - quoting values/g)).toHaveLength(1);
    expect(exampleText).toContain('.env -> .env.<ENV> -> .env.<ENV>.local -> the real environment');
    expect(exampleText).toContain('ENV=qa reads .env.qa.local, NOT .env.local');
    expect(exampleText).toContain('$env:LOG_LEVEL = "debug"');
    expect(exampleText).toContain('Copy-Item .env.local.example');
  });

  test('the secrets are marked, and .env.local.example has exactly those (as placeholders)', () => {
    const secrets = [...example.values()].filter(isSecret).map((e) => e.name).sort();
    expect(secrets).toEqual(['REMOTE_DB_CONNECTION_STRING', 'REMOTE_RDP_PASSWORD', 'SFTP_PASSWORD', 'SMTP_PASS']);
    const local = read('.env.local.example');
    const localEntries = [...local.split(/\r?\n/)].filter((l) => new RegExp(`^#?\\s?${NAME}=`).test(l));
    const localKeys = localEntries.map((l) => new RegExp(`^#?\\s?(${NAME})=`).exec(l)?.[1] as string).sort();
    expect(localKeys).toEqual(secrets);
    for (const line of localEntries) expect(line, 'a placeholder in double quotes, never a real-looking value').toMatch(new RegExp(`^#?\\s?${NAME}="<[a-z0-9 -]+>"$`));
    expect(local).toContain('.env.qa.local');
  });

  test('the README "Configuration reference" table lists exactly the variables of .env.example, with the same secrets', () => {
    const table = readmeTable(read('README.md'));
    expect(table.size, 'the README table was not found or is empty').toBeGreaterThanOrEqual(60);
    expect(missingFrom(example.keys(), table), 'in .env.example but not in the README table').toEqual([]);
    expect(missingFrom(table.keys(), example), 'in the README table but not in .env.example').toEqual([]);
    for (const entry of example.values()) expect(table.get(entry.name), `${entry.name}: the Secret column must agree with .env.example`).toBe(isSecret(entry));
  });

  test('the load order the documentation describes is the one loadEnv implements', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-docs-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'DOCS_FROM_BASE=base\nDOCS_OVERRIDDEN=base\n');
      fs.writeFileSync(path.join(dir, '.env.qa'), 'ENV=ignored\nDOCS_OVERRIDDEN=qa\nLOG_LEVEL=debug\n');
      fs.writeFileSync(path.join(dir, '.env.qa.local'), 'DOCS_SECRET=from-local\nDOCS_OVERRIDDEN=qa-local\n');
      fs.writeFileSync(path.join(dir, '.env.local'), 'DOCS_NEVER_READ=1\n');
      const before = process.env.LOG_LEVEL;
      const env = loadEnv({ dir, env: 'qa' });
      expect(env.get('DOCS_FROM_BASE')).toBe('base');
      expect(env.get('DOCS_OVERRIDDEN')).toBe('qa-local');
      expect(env.get('DOCS_SECRET')).toBe('from-local');
      expect(env.has('DOCS_NEVER_READ'), 'a file called .env.local is not read for ENV=qa').toBe(false);
      expect(env.envName, 'ENV inside a file does not choose the environment').toBe('qa');
      // "real environment only" variables: loadEnv hands values to the caller, it does not export them to process.env
      expect(env.get('LOG_LEVEL')).toBe(process.env.LOG_LEVEL ?? 'debug');
      expect(process.env.LOG_LEVEL).toBe(before);
      expect(process.env.DOCS_FROM_BASE).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.describe('negative controls: the checks above do fail when the documentation drifts', () => {
    test('a variable read in code but not documented is reported, one only mentioned in a comment is not', () => {
      const source = "const a = env.getInt('SOME_NEW_KEY', 1);\n// env.get('ONLY_IN_A_COMMENT')\nconst b = process.env.ANOTHER_NEW_KEY;\n/* process.env.IN_A_BLOCK */";
      const keys = keysRead(source);
      expect([...keys].sort()).toEqual(['ANOTHER_NEW_KEY', 'SOME_NEW_KEY']);
      const documented = parseExample('# Something.\n# Read from: x\n# Values: x\n# Default: x | Required: no | Secret: no\n# Example: OLD_KEY=1\n# OLD_KEY=1\n');
      expect(missingFrom(keys, documented)).toEqual(['ANOTHER_NEW_KEY', 'SOME_NEW_KEY']);
      expect(missingFrom(documented.keys(), keys)).toEqual(['OLD_KEY']);
    });

    test('a variable block with missing or copy-pasted metadata is reported', () => {
      const broken = parseExample(
        ['# What it is for.', '# Values: a | b', '# Default: a | Required: no | Secret: no', '# Example: OTHER=1', '# FIRST=a', '', '# Only a sentence.', '# SECOND=b', ''].join('\n'),
      );
      const problems = metadataProblems(broken).join('\n');
      expect(problems).toContain('FIRST: no "Read from:" line');
      expect(problems).toContain('FIRST: its Example line shows OTHER=');
      expect(problems).toContain('SECOND: no "Values:" line');
      expect(problems).toContain('SECOND: no "Default: ... | Required: ... | Secret: no|YES" line');
      expect(problems).toContain('SECOND: no "Example: SECOND=..." line');
    });

    test('a README table that lacks a variable or disagrees about a secret is reported', () => {
      const readme = '\n## Configuration reference\n\n| Name | Purpose | Default | Required | Secret |\n|---|---|---|---|---|\n| `KEY_A` | a | 1 | no | no |\n| `KEY_B` | b | - | no | **YES** |\n\n## Next\n| `KEY_C` | c | 1 | no | no |\n';
      const table = readmeTable(readme);
      expect([...table.keys()]).toEqual(['KEY_A', 'KEY_B']);
      expect(table.get('KEY_B')).toBe(true);
      expect(missingFrom(['KEY_A', 'KEY_B', 'KEY_C'], table)).toEqual(['KEY_C']);
      expect(readmeTable('no such section').size).toBe(0);
    });

    test('script variables: a registry-style read is found, a variable the script sets itself is not', () => {
      expect([...scriptKeys('if [ -n "${NPM_REGISTRY_URL:-}" ]; then echo; fi\nDRY_RUN=0\necho ${DRY_RUN:-}${OTHER-x}', 'sh')].sort()).toEqual(['NPM_REGISTRY_URL', 'OTHER']);
      expect([...scriptKeys('if defined NPM_REGISTRY_URL echo\nif not defined TARBALL echo\nfor %%T do set "TARBALL=%%T"', 'bat')]).toEqual(['NPM_REGISTRY_URL']);
      expect([...scriptKeys('  AUTOMATION_MIN_EXECUTED: "1"\nscript: ${CI_PROJECT_DIR} ${AUDIT_RUN_GATES:+--run}', 'yml')].sort()).toEqual(['AUDIT_RUN_GATES', 'AUTOMATION_MIN_EXECUTED']);
    });
  });
});
