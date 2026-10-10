import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The deterministic part of the fortnightly framework audit: everything that can be checked from files and from the
 * repo's own scripts, with evidence (file:line). It does NOT replace the judgement-based review (oracle quality, design
 * techniques, flakiness triage) - the report ends with that checklist and docs/governance/AUDIT_PROMPT.md.
 *
 * Nothing here needs a network or a dependency beyond Node itself.
 */

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const AUDIT_SEVERITIES: AuditSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface AuditFinding {
  rule: string;
  severity: AuditSeverity;
  repo: string;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  /** How many places matched (evidence lists the first few). */
  count?: number;
  evidence?: string[];
}

export interface RepoRef {
  name: string;
  dir: string;
}

export interface RunResult {
  script: string;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of output, for the report. */
  tail: string;
}

export interface TestRunSummary {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
}

export interface RepoReport {
  repo: string;
  inventory: { sourceFiles: number; testFiles: number; tests: number; scenarios: number };
  findings: AuditFinding[];
  ignored: Array<{ rule: string; file?: string; reason: string }>;
  runs: RunResult[];
  testSummary?: TestRunSummary;
}

export interface AuditReport {
  generatedAt: string;
  node: string;
  repos: RepoReport[];
  /** Findings that compare repos with each other (versions, duplicated tests). */
  family: AuditFinding[];
}

export interface IgnoreRule {
  rule: string;
  /** A path prefix (repo-relative) the exception applies to; omitted means the whole repo. */
  path?: string;
  reason: string;
  owner?: string;
  /** ISO date; after it the exception no longer applies. */
  expires?: string;
}

export interface AuditConfig {
  ignore?: IgnoreRule[];
  /** Matches a requirement / story id in a test title, tag or annotation. */
  requirementPattern?: string;
  /** Phrases that must not appear in the docs (a retired procedure, an old command). */
  staleDocPhrases?: string[];
  /** Minimum share of tests carrying a requirement id before the traceability finding drops to 'low'. */
  traceabilityTarget?: number;
}

export interface AuditOptions {
  repos: RepoRef[];
  /** Run lint, typecheck, test and security in each repo and report the outcome (slow). */
  run?: boolean;
  now?: Date;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.features-gen',
  'test-results',
  'playwright-report',
  'allure-results',
  'allure-report',
  'logs',
  'coverage',
  'audit-reports',
  'recordings',
  '.auth',
  '.secrets',
  'shared-packages',
]);

const DEFAULT_STALE_PHRASES = [
  'file:../shared-packages',
  'no registry yet',
  'Distributing this package',
  'builds it automatically from a sibling',
];
const DEFAULT_REQUIREMENT_PATTERN = '@?REQ-[A-Za-z0-9_-]+';
const MAX_EVIDENCE = 5;

// ---------------------------------------------------------------------------------------------------------------------
// reading files

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), accept, out);
    } else if (entry.isFile()) {
      const file = path.join(dir, entry.name);
      if (accept(file)) out.push(file);
    }
  }
  return out;
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------------------------------
// a tiny tokenizer: blank comments and string contents so a rule never fires on text that merely MENTIONS a pattern

export interface CodeViews {
  /** Comments removed and the CONTENT of every string / template blanked (delimiters kept): for structural rules. */
  code: string[];
  /** Comments removed and template literals blanked, but ordinary quoted strings kept: for rules that need a literal. */
  literals: string[];
}

export function codeViews(text: string): CodeViews {
  const code: string[] = [];
  const literals: string[] = [];
  let c = '';
  let l = '';
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  const flush = () => {
    code.push(c);
    literals.push(l);
    c = '';
    l = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '\n') {
      flush();
      if (state === 'line' || state === 'single' || state === 'double') state = 'code';
      continue;
    }
    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line';
          i++;
          c += '  ';
          l += '  ';
        } else if (ch === '/' && next === '*') {
          state = 'block';
          i++;
          c += '  ';
          l += '  ';
        } else if (ch === "'") {
          state = 'single';
          c += ch;
          l += ch;
        } else if (ch === '"') {
          state = 'double';
          c += ch;
          l += ch;
        } else if (ch === '`') {
          state = 'template';
          c += ch;
          l += ch;
        } else {
          c += ch;
          l += ch;
        }
        break;
      case 'line':
        c += ' ';
        l += ' ';
        break;
      case 'block':
        if (ch === '*' && next === '/') {
          state = 'code';
          i++;
          c += '  ';
          l += '  ';
        } else {
          c += ' ';
          l += ' ';
        }
        break;
      case 'single':
      case 'double': {
        const quote = state === 'single' ? "'" : '"';
        if (ch === '\\') {
          c += '__';
          l += ch + (next ?? '');
          i++;
        } else if (ch === quote) {
          state = 'code';
          c += ch;
          l += ch;
        } else {
          c += '_';
          l += ch;
        }
        break;
      }
      case 'template':
        if (ch === '\\') {
          c += '__';
          l += '__';
          i++;
        } else if (ch === '`') {
          state = 'code';
          c += ch;
          l += ch;
        } else {
          c += '_';
          l += '_';
        }
        break;
    }
  }
  flush();
  return { code, literals };
}

// ---------------------------------------------------------------------------------------------------------------------
// code rules

interface CodeRule {
  id: string;
  severity: AuditSeverity;
  title: string;
  why: string;
  /** Which files: tests only, source only, or both. */
  scope: 'tests' | 'src' | 'all';
  view: 'code' | 'literals';
  pattern: RegExp;
  /** Return true to skip a matching line (e.g. file-system deletes for `force: true`). */
  skip?: (code: string, literal: string) => boolean;
}

const CODE_RULES: CodeRule[] = [
  {
    id: 'wait-fixed',
    severity: 'high',
    title: 'Fixed wait (waitForTimeout)',
    why: 'A fixed sleep is a guess: too short is flaky, too long wastes time. Wait for a state or use a web-first assertion.',
    scope: 'all',
    view: 'code',
    pattern: /\bwaitForTimeout\s*\(/,
  },
  {
    id: 'wait-networkidle',
    severity: 'high',
    title: "'networkidle' wait",
    why: "Pages that poll or stream never go idle; wait for the element or response you need.",
    scope: 'all',
    view: 'literals',
    pattern: /(?:waitForLoadState|waitUntil|goto|reload|waitForURL)\b[^;]*['"]networkidle['"]/,
  },
  {
    id: 'sleep-promise',
    severity: 'medium',
    title: 'Hand-rolled sleep (await new Promise(setTimeout))',
    why: 'Same problem as a fixed wait, hidden behind a helper. Use expect.poll / toPass or a built-in wait.',
    scope: 'tests',
    view: 'code',
    pattern: /new Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\s*\(/,
  },
  {
    id: 'test-only',
    severity: 'high',
    title: 'test.only / describe.only left in code',
    why: 'Silently skips every other test; forbidOnly only protects CI.',
    scope: 'all',
    view: 'code',
    pattern: /\b(?:test|it|describe)\.only\s*\(/,
  },
  {
    id: 'test-skipped',
    severity: 'medium',
    title: 'Unconditional skip / fixme',
    why: 'A skipped test is invisible risk; fix it, delete it, or link the reason and an owner.',
    scope: 'tests',
    view: 'code',
    pattern: /\b(?:test|it|describe)\.(?:skip|fixme)\s*\(\s*['"`]/,
  },
  {
    id: 'force-action',
    severity: 'medium',
    title: '{ force: true } on an action',
    why: 'Force skips actionability checks and hides the real timing or overlay problem.',
    scope: 'all',
    view: 'code',
    pattern: /\bforce\s*:\s*true\b/,
    skip: (line) => /\b(?:rm|rmSync|rmdir|rmdirSync|unlink)\b/.test(line),
  },
  {
    id: 'assert-not-web-first',
    severity: 'medium',
    title: 'Non-web-first assertion (expect(await x.isVisible()))',
    why: 'Reads state once and does not retry; use expect(locator).toBeVisible() so it waits.',
    scope: 'tests',
    view: 'code',
    pattern: /expect\s*\(\s*await\s+(?!actions\.)[^)]*\.(?:isVisible|isHidden|isEnabled|isDisabled|isChecked|textContent|innerText|inputValue)\s*\(/,
  },
  {
    id: 'locator-brittle',
    severity: 'low',
    title: 'Brittle locator (XPath or nth-child)',
    why: 'Coupled to page structure; prefer getByRole / getByLabel / getByTestId.',
    scope: 'all',
    view: 'literals',
    pattern: /(?:locator\s*\(\s*['"`]\s*(?:xpath=|\/\/)|nth-child\s*\()/,
  },
  {
    id: 'serial-mode',
    severity: 'low',
    title: 'Serial test mode',
    why: 'Serial tests depend on order and stop at the first failure; make tests independent where possible.',
    scope: 'tests',
    view: 'literals',
    pattern: /mode\s*:\s*['"]serial['"]|describe\.serial\s*\(/,
  },
  {
    id: 'assert-weak-throw',
    severity: 'low',
    title: 'toThrow() without an expected error',
    why: 'Passes for ANY error, including the wrong one; assert the message or type.',
    scope: 'tests',
    view: 'code',
    pattern: /(?<!\.not)\.toThrow\s*\(\s*\)/,
  },
  {
    id: 'listen-all-interfaces',
    severity: 'medium',
    title: 'Server listens on all interfaces',
    why: 'A test/mock server without an explicit host is reachable from the runner network.',
    scope: 'all',
    view: 'code',
    pattern: /\.listen\s*\(/,
    skip: (code, literal) => /127\.0\.0\.1|localhost|::1|\bhost\b|\bhostname\b|\blistenHost\b/i.test(literal) || !/\.listen\s*\([^)]*\)/.test(code),
  },
];

interface Evidence {
  file: string;
  line: number;
  text: string;
}

function isTestFile(relative: string): boolean {
  return /^(?:tests|features)\//.test(relative) || /\.(?:spec|test)\.[tj]s$/.test(relative);
}

function scanCode(root: string, files: string[], repo: string): AuditFinding[] {
  const matches = new Map<string, Evidence[]>();
  for (const file of files) {
    const relative = rel(root, file);
    const views = codeViews(read(file));
    const testFile = isTestFile(relative);
    const original = read(file).split('\n');
    for (const rule of CODE_RULES) {
      if (rule.scope === 'tests' && !testFile) continue;
      if (rule.scope === 'src' && testFile) continue;
      const lines = rule.view === 'code' ? views.code : views.literals;
      lines.forEach((text, index) => {
        if (!rule.pattern.test(text)) return;
        if (rule.skip?.(text, views.literals[index] ?? text)) return;
        const list = matches.get(rule.id) ?? [];
        list.push({ file: relative, line: index + 1, text: (original[index] ?? '').trim().slice(0, 140) });
        matches.set(rule.id, list);
      });
    }
  }
  const findings: AuditFinding[] = [];
  for (const rule of CODE_RULES) {
    const list = matches.get(rule.id);
    if (!list || list.length === 0) continue;
    const first = list[0] as Evidence;
    findings.push({
      rule: rule.id,
      severity: rule.severity,
      repo,
      title: rule.title,
      detail: rule.why,
      file: first.file,
      line: first.line,
      count: list.length,
      evidence: list.slice(0, MAX_EVIDENCE).map((e) => `${e.file}:${e.line}  ${e.text}`),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// tests: inventory, traceability, tags

const TEST_START = /^\s*(?:test|it)(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])/;
const GHERKIN_SCENARIO = /^\s*Scenario(?: Outline)?\s*:/;

interface TestInfo {
  file: string;
  line: number;
  traced: boolean;
  smoke: boolean;
  regression: boolean;
}

function collectTests(root: string, files: string[], requirement: RegExp): { tests: TestInfo[]; scenarios: TestInfo[] } {
  const tests: TestInfo[] = [];
  const scenarios: TestInfo[] = [];
  for (const file of files) {
    const relative = rel(root, file);
    const lines = read(file).split('\n');
    if (file.endsWith('.feature')) {
      let featureTags = '';
      let pending = '';
      lines.forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('@')) pending += ` ${trimmed}`;
        else if (/^Feature\s*:/.test(trimmed)) {
          featureTags = pending;
          pending = '';
        } else if (GHERKIN_SCENARIO.test(text)) {
          const tags = `${featureTags} ${pending}`;
          scenarios.push({
            file: relative,
            line: index + 1,
            traced: requirement.test(`${tags} ${trimmed}`),
            smoke: /@smoke\b/.test(tags),
            regression: /@regression\b/.test(tags),
          });
          pending = '';
        } else if (trimmed !== '' && !trimmed.startsWith('#')) pending = '';
      });
      continue;
    }
    if (!isTestFile(relative) || !/\.[tj]s$/.test(relative)) continue;
    const views = codeViews(lines.join('\n'));
    lines.forEach((text, index) => {
      if (!TEST_START.test(views.literals[index] ?? '')) return;
      const window = lines.slice(index, index + 6).join(' ');
      tests.push({
        file: relative,
        line: index + 1,
        traced: requirement.test(text) || /annotation\s*:/.test(window) && requirement.test(window),
        smoke: /@smoke\b/.test(text),
        regression: /@regression\b/.test(text),
      });
    });
  }
  return { tests, scenarios };
}

function traceabilityFinding(
  repo: string,
  all: TestInfo[],
  target: number,
  pattern: string,
): AuditFinding | undefined {
  if (all.length < 10) return undefined;
  const traced = all.filter((t) => t.traced).length;
  const share = traced / all.length;
  if (share >= target) return undefined;
  return {
    rule: 'traceability',
    severity: traced === 0 ? 'medium' : 'low',
    repo,
    title: `Requirement traceability: ${traced} of ${all.length} tests carry a requirement id`,
    detail: `No way to report coverage against requirements or risks. Put an id matching /${pattern}/ in the test title, a tag or an annotation (see docs/governance/AUDIT.md). Target: ${Math.round(target * 100)}%.`,
    count: all.length - traced,
  };
}

function tagFinding(repo: string, all: TestInfo[]): AuditFinding | undefined {
  if (all.length < 10) return undefined;
  const smoke = all.filter((t) => t.smoke).length;
  const regression = all.filter((t) => t.regression).length;
  if (smoke > 0 || regression > 0) return undefined;
  return {
    rule: 'tags',
    severity: 'low',
    repo,
    title: 'No @smoke / @regression tags',
    detail: 'Without tags there is no quick pre-merge subset; tag the critical journeys @smoke.',
    count: all.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// dependencies, governance

interface PackageJson {
  name?: string;
  license?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function dependencyFindings(root: string, repo: string, pkg: PackageJson): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const all = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
  const local = Object.entries(all).filter(
    ([name, spec]) => name.startsWith('@automation/') && /^(?:file:|link:)|\.tgz$/.test(spec),
  );
  if (local.length > 0)
    findings.push({
      rule: 'dep-local-package',
      severity: 'high',
      repo,
      title: '@automation packages pinned to a local file',
      detail: 'Consumers install shared packages by version from the registry; a file:/.tgz dependency cannot be reproduced elsewhere and goes stale.',
      count: local.length,
      evidence: local.map(([name, spec]) => `package.json  ${name}: ${spec}`),
    });
  const bdd = pkg.devDependencies?.['playwright-bdd'] ?? pkg.dependencies?.['playwright-bdd'];
  if (bdd && /^[\^~><]/.test(bdd))
    findings.push({
      rule: 'dep-bdd-not-pinned',
      severity: 'medium',
      repo,
      title: `playwright-bdd is a range (${bdd}), not an exact version`,
      detail: 'playwright-bdd is tightly coupled to Playwright; pin it and upgrade on purpose.',
      file: 'package.json',
    });
  if (!fs.existsSync(path.join(root, 'package-lock.json')))
    findings.push({
      rule: 'dep-no-lockfile',
      severity: 'high',
      repo,
      title: 'No package-lock.json',
      detail: 'Without a lockfile every install floats to the newest versions of everything, Playwright included.',
    });
  return findings;
}

function installedVersion(root: string, name: string): string | undefined {
  return readJson<{ version?: string }>(path.join(root, 'node_modules', name, 'package.json'))?.version;
}

function governanceFindings(root: string, repo: string, pkg: PackageJson, now: Date): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (pkg.license === 'UNLICENSED')
    findings.push({
      rule: 'gov-licence',
      severity: 'info',
      repo,
      title: 'Licence is UNLICENSED',
      detail: 'Fine for internal use; a decision is needed before the code is shared beyond the organisation.',
      file: 'package.json',
    });
  const owners = ['CODEOWNERS', '.gitlab/CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].some((f) =>
    fs.existsSync(path.join(root, f)),
  );
  if (!owners)
    findings.push({
      rule: 'gov-codeowners',
      severity: 'medium',
      repo,
      title: 'No CODEOWNERS file',
      detail: 'Nobody is accountable for reviewing changes to this repo (TMMi peer reviews).',
    });
  const allowFile = path.join(root, 'audit-allowlist.json');
  const allow = readJson<{ allow?: Array<{ id?: string; owner?: string; expires?: string }> }>(allowFile);
  for (const entry of allow?.allow ?? []) {
    const label = entry.id ?? '(no id)';
    if (!entry.owner || /^unassigned/i.test(entry.owner))
      findings.push({
        rule: 'gov-allowlist-owner',
        severity: 'medium',
        repo,
        title: `Accepted advisory ${label} has no owner`,
        detail: 'An exception nobody owns is never re-decided.',
        file: 'audit-allowlist.json',
      });
    if (entry.expires) {
      const days = Math.floor((Date.parse(entry.expires) - now.getTime()) / 86_400_000);
      if (Number.isNaN(days)) continue;
      if (days < 0)
        findings.push({
          rule: 'gov-allowlist-expired',
          severity: 'high',
          repo,
          title: `Accepted advisory ${label} expired ${-days} day(s) ago`,
          detail: 'The exception no longer applies; re-decide it or fix the dependency.',
          file: 'audit-allowlist.json',
        });
      else if (days <= 30)
        findings.push({
          rule: 'gov-allowlist-expiring',
          severity: 'medium',
          repo,
          title: `Accepted advisory ${label} expires in ${days} day(s)`,
          detail: 'Re-decide it before the gate starts failing.',
          file: 'audit-allowlist.json',
        });
    }
  }
  const adrDir = path.join(root, 'docs', 'adr');
  if (fs.existsSync(adrDir)) {
    const unapproved = fs
      .readdirSync(adrDir)
      .filter((f) => /^\d{4}-.*\.md$/.test(f) && !f.startsWith('0000'))
      .filter((f) => /Approved by:\*\*\s*_not yet recorded_/.test(read(path.join(adrDir, f))));
    if (unapproved.length > 0)
      findings.push({
        rule: 'gov-adr-approval',
        severity: 'low',
        repo,
        title: `${unapproved.length} ADR(s) not approved by anyone`,
        detail: 'Documented but not ratified; an approver records name and date in the Approved by line.',
        count: unapproved.length,
        evidence: unapproved.slice(0, MAX_EVIDENCE).map((f) => `docs/adr/${f}`),
      });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// pipeline

function topLevelBlocks(yaml: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = yaml.split('\n');
  let name = '';
  let body: string[] = [];
  const close = () => {
    if (name) blocks.set(name, body.join('\n'));
  };
  for (const line of lines) {
    const m = /^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line);
    if (m) {
      close();
      name = m[1] as string;
      body = [];
    } else if (name) body.push(line);
  }
  close();
  return blocks;
}

function pipelineFindings(root: string, repo: string, pkg: PackageJson, shared: boolean): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const ciFile = path.join(root, '.gitlab-ci.yml');
  if (!fs.existsSync(ciFile)) {
    findings.push({
      rule: 'ci-missing',
      severity: 'high',
      repo,
      title: 'No .gitlab-ci.yml',
      detail: 'Nothing runs these tests on a merge request.',
    });
    return findings;
  }
  const ci = read(ciFile);
  const scrubbed = ci
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const blocks = topLevelBlocks(scrubbed);

  for (const [name, body] of blocks) {
    if (!/secur/i.test(name)) continue;
    if (/allow_failure:\s*true\b/.test(body))
      findings.push({
        rule: 'ci-security-nonblocking',
        severity: 'medium',
        repo,
        title: `Job '${name}' cannot block the pipeline (allow_failure: true)`,
        detail: 'A high advisory or a committed secret still gives a green pipeline. Use allow_failure: { exit_codes: 2 } once the gate has run green.',
        file: '.gitlab-ci.yml',
      });
  }
  if (pkg.scripts?.typecheck && !/typecheck/.test(scrubbed))
    findings.push({
      rule: 'ci-no-typecheck',
      severity: 'medium',
      repo,
      title: 'CI never runs npm run typecheck',
      detail: 'Playwright transpiles without type checking, so type errors in specs are never caught.',
      file: '.gitlab-ci.yml',
    });
  const hasFeatures = walk(path.join(root, 'features'), (f) => f.endsWith('.feature')).length > 0;
  if (hasFeatures) {
    const called = [...scrubbed.matchAll(/npm (?:run )?([\w:-]+)/g)].map((m) => m[1] as string);
    const generated = called.some((s) => /bddgen/.test(pkg.scripts?.[s] ?? '')) || /bddgen/.test(scrubbed);
    if (!generated)
      findings.push({
        rule: 'ci-bdd-not-generated',
        severity: 'medium',
        repo,
        title: 'Feature files exist but no pipeline step runs bddgen',
        detail: 'The generated BDD specs do not exist in CI, so the features silently run nothing.',
        file: '.gitlab-ci.yml',
      });
  }
  const image = /playwright:v(\d+\.\d+\.\d+)/.exec(scrubbed)?.[1];
  const installed = installedVersion(root, '@playwright/test');
  if (image && installed && image !== installed) {
    const installs = /playwright install/.test(scrubbed);
    findings.push({
      rule: 'ci-image-mismatch',
      severity: installs ? 'info' : 'high',
      repo,
      title: `Pipeline image has Playwright ${image}, the repo uses ${installed}`,
      detail: installs
        ? 'The job installs matching browsers at run time (needs a reachable browser source).'
        : 'The image browsers do not match this Playwright version and nothing installs the right ones.',
      file: '.gitlab-ci.yml',
    });
  }
  if (!shared && !/^include:/m.test(scrubbed))
    findings.push({
      rule: 'ci-no-shared-template',
      severity: 'low',
      repo,
      title: 'Pipeline does not include the shared CI template',
      detail: 'Each repo carries its own copy of the pipeline, so one fix means several edits.',
      file: '.gitlab-ci.yml',
    });
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// docs

const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

function headingsOf(text: string): Set<string> {
  const set = new Set<string>();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) set.add(slug(m[1] as string));
  }
  return set;
}

function docFindings(root: string, repo: string, config: AuditConfig): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const docs = walk(root, (f) => f.endsWith('.md'));
  const broken: string[] = [];
  const stale: string[] = [];
  const phrases = config.staleDocPhrases ?? DEFAULT_STALE_PHRASES;
  const headingCache = new Map<string, Set<string>>();
  const headings = (file: string) => {
    let h = headingCache.get(file);
    if (!h) headingCache.set(file, (h = headingsOf(read(file))));
    return h;
  };
  const imageVersions = new Map<string, string>();
  for (const doc of docs) {
    const relative = rel(root, doc);
    const text = read(doc);
    const lines = text.split('\n');
    let fenced = false;
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) return;
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] as string;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
        const [filePart, anchor] = target.split('#') as [string, string | undefined];
        const resolved = filePart === '' ? doc : path.resolve(path.dirname(doc), decodeURIComponent(filePart));
        if (!resolved.startsWith(root)) continue;
        if (!fs.existsSync(resolved)) {
          broken.push(`${relative}:${index + 1}  ${target}  (no such file)`);
        } else if (anchor && resolved.endsWith('.md') && !headings(resolved).has(anchor.toLowerCase())) {
          broken.push(`${relative}:${index + 1}  ${target}  (no such heading)`);
        }
      }
      const exempt = /(^|\/)CHANGELOG\.md$|^docs\/adr\/00(?:02|10)/.test(relative);
      if (!exempt)
        for (const phrase of phrases)
          if (line.includes(phrase)) stale.push(`${relative}:${index + 1}  "${phrase}"`);
      const image = /playwright:v(\d+\.\d+\.\d+)/.exec(line)?.[1];
      if (image && /README/i.test(relative)) imageVersions.set(relative, image);
    });
  }
  if (broken.length > 0)
    findings.push({
      rule: 'doc-broken-link',
      severity: 'low',
      repo,
      title: `${broken.length} broken link(s) or anchor(s) in the docs`,
      detail: 'A link that goes nowhere sends the reader to a retired or renamed section.',
      count: broken.length,
      evidence: broken.slice(0, MAX_EVIDENCE),
    });
  if (stale.length > 0)
    findings.push({
      rule: 'doc-stale-phrase',
      severity: 'medium',
      repo,
      title: `${stale.length} mention(s) of a retired procedure in the docs`,
      detail: `Phrases that describe how things used to work: ${phrases.map((p) => `"${p}"`).join(', ')}. Edit staleDocPhrases in .framework-audit.json when a procedure is retired.`,
      count: stale.length,
      evidence: stale.slice(0, MAX_EVIDENCE),
    });
  const ci = read(path.join(root, '.gitlab-ci.yml'));
  const ciImage = /playwright:v(\d+\.\d+\.\d+)/.exec(ci)?.[1];
  if (ciImage)
    for (const [file, version] of imageVersions)
      if (version !== ciImage)
        findings.push({
          rule: 'doc-image-mismatch',
          severity: 'medium',
          repo,
          title: `${file} names Playwright image ${version}, the pipeline uses ${ciImage}`,
          detail: 'The documentation describes a different CI environment than the one that runs.',
          file,
        });
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// running the repo's own gates

function runScript(root: string, script: string): RunResult {
  const started = Date.now();
  const result = spawnSync('npm', ['run', script], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 45 * 60_000,
    env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n');
  return {
    script,
    exitCode: result.status,
    durationMs: Date.now() - started,
    tail: output.slice(-12).join('\n'),
  };
}

function readRunSummary(root: string): TestRunSummary | undefined {
  const report = readJson<{ stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number } }>(
    path.join(root, 'test-results', 'results.json'),
  );
  if (!report?.stats) return undefined;
  const s = report.stats;
  return { expected: s.expected ?? 0, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, skipped: s.skipped ?? 0 };
}

const NETWORK_FAILURE = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|audit endpoint|could not run/i;

function runFindings(repo: string, runs: RunResult[], summary: TestRunSummary | undefined): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const run of runs) {
    if (run.exitCode === 0) continue;
    const network = run.script === 'security' && (run.exitCode === 2 || NETWORK_FAILURE.test(run.tail));
    findings.push({
      rule: `run-${run.script}`,
      severity: network ? 'medium' : 'high',
      repo,
      title: network ? `npm run ${run.script} could not run (network)` : `npm run ${run.script} failed (exit ${run.exitCode})`,
      detail: network
        ? 'The security gate needs the registry; run it where NPM_REGISTRY_URL is reachable.'
        : 'The repo\'s own gate is red.',
      evidence: run.tail.split('\n').slice(-5),
    });
  }
  if (summary) {
    const executed = summary.expected + summary.unexpected + summary.flaky;
    if (executed === 0)
      findings.push({
        rule: 'run-zero-executed',
        severity: 'high',
        repo,
        title: 'The test run executed no tests',
        detail: 'Zero tests is a green run that proves nothing.',
      });
    if (summary.flaky > 0)
      findings.push({
        rule: 'run-flaky',
        severity: 'medium',
        repo,
        title: `${summary.flaky} flaky test(s) (${((summary.flaky / Math.max(executed, 1)) * 100).toFixed(1)}% of ${executed})`,
        detail: 'Passed only on retry; retries hide the problem. Find the cause (see automation-run-report).',
        count: summary.flaky,
      });
    if (summary.skipped > 0)
      findings.push({
        rule: 'run-skipped',
        severity: 'low',
        repo,
        title: `${summary.skipped} test(s) skipped in the run`,
        detail: 'Check each skip has a reason that still holds.',
        count: summary.skipped,
      });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// ignores

function applyIgnores(
  findings: AuditFinding[],
  ignores: IgnoreRule[],
  now: Date,
): { kept: AuditFinding[]; ignored: RepoReport['ignored'] } {
  const kept: AuditFinding[] = [];
  const ignored: RepoReport['ignored'] = [];
  for (const finding of findings) {
    const rule = ignores.find(
      (i) =>
        i.rule === finding.rule &&
        (!i.path || (finding.file ?? '').startsWith(i.path)) &&
        (!i.expires || Date.parse(i.expires) >= now.getTime()),
    );
    if (rule) ignored.push({ rule: finding.rule, file: finding.file, reason: rule.reason });
    else kept.push(finding);
  }
  return { kept, ignored };
}

// ---------------------------------------------------------------------------------------------------------------------
// family-level comparisons

function lineSet(file: string): Set<string> {
  return new Set(
    read(file)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 3),
  );
}

function familyFindings(repos: Array<{ ref: RepoRef; root: string }>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (repos.length < 2) return findings;
  const family = 'family';

  const versions = new Map<string, string[]>();
  for (const { ref, root } of repos) {
    for (const lib of ['@playwright/test', 'playwright-bdd']) {
      const v = installedVersion(root, lib);
      if (!v) continue;
      versions.set(lib, [...(versions.get(lib) ?? []), `${ref.name}=${v}`]);
    }
  }
  for (const [lib, list] of versions) {
    const distinct = new Set(list.map((s) => s.split('=')[1]));
    if (distinct.size > 1)
      findings.push({
        rule: 'family-version-drift',
        severity: 'high',
        repo: family,
        title: `${lib} differs across the repos`,
        detail: 'One Playwright (and playwright-bdd) version for the whole family keeps traces, browsers and reporters compatible.',
        evidence: list,
      });
  }

  const byName = new Map<string, Array<{ repo: string; file: string }>>();
  for (const { ref, root } of repos) {
    for (const file of walk(path.join(root, 'tests'), (f) => /\.spec\.ts$/.test(f))) {
      const name = path.basename(file);
      byName.set(name, [...(byName.get(name) ?? []), { repo: ref.name, file }]);
    }
  }
  const duplicated: string[] = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const base = lineSet((list[0] as { file: string }).file);
    for (const other of list.slice(1)) {
      const set = lineSet(other.file);
      const shared = [...set].filter((l) => base.has(l)).length;
      const similarity = shared / Math.max(base.size, set.size, 1);
      if (similarity >= 0.8) duplicated.push(`${name}  ${(list[0] as { repo: string }).repo} ~ ${other.repo}  (${Math.round(similarity * 100)}% identical lines)`);
    }
  }
  if (duplicated.length > 0)
    findings.push({
      rule: 'family-duplicated-tests',
      severity: 'medium',
      repo: family,
      title: `${duplicated.length} test file(s) duplicated across repos`,
      detail: 'Copies drift and inflate test counts; keep the test where the code lives.',
      count: duplicated.length,
      evidence: duplicated.slice(0, MAX_EVIDENCE),
    });
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// entry point

export function loadAuditConfig(root: string): AuditConfig {
  return readJson<AuditConfig>(path.join(root, '.framework-audit.json')) ?? {};
}

export function auditRepo(ref: RepoRef, options: { run?: boolean; now?: Date; shared?: boolean } = {}): RepoReport {
  const root = path.resolve(ref.dir);
  const now = options.now ?? new Date();
  const config = loadAuditConfig(root);
  const pkg = readJson<PackageJson>(path.join(root, 'package.json')) ?? {};
  const requirement = new RegExp(config.requirementPattern ?? DEFAULT_REQUIREMENT_PATTERN);

  const codeFiles = walk(root, (f) => /\.(?:ts|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'));
  const featureFiles = walk(root, (f) => f.endsWith('.feature'));
  const { tests, scenarios } = collectTests(root, [...codeFiles, ...featureFiles], requirement);

  const findings: AuditFinding[] = [
    ...scanCode(root, codeFiles, ref.name),
    ...dependencyFindings(root, ref.name, pkg),
    ...governanceFindings(root, ref.name, pkg, now),
    ...pipelineFindings(root, ref.name, pkg, options.shared ?? ref.name.endsWith('-utils')),
    ...docFindings(root, ref.name, config),
  ];
  const trace = traceabilityFinding(
    ref.name,
    [...tests, ...scenarios],
    config.traceabilityTarget ?? 0.5,
    config.requirementPattern ?? DEFAULT_REQUIREMENT_PATTERN,
  );
  if (trace) findings.push(trace);
  const tag = tagFinding(ref.name, [...tests, ...scenarios]);
  if (tag) findings.push(tag);

  let runs: RunResult[] = [];
  let testSummary: TestRunSummary | undefined;
  if (options.run) {
    runs = ['lint', 'typecheck', 'test', 'security']
      .filter((script) => pkg.scripts?.[script])
      .map((script) => runScript(root, script));
    testSummary = readRunSummary(root);
    findings.push(...runFindings(ref.name, runs, testSummary));
  }

  const { kept, ignored } = applyIgnores(findings, config.ignore ?? [], now);
  const order = (s: AuditSeverity) => AUDIT_SEVERITIES.indexOf(s);
  kept.sort((a, b) => order(a.severity) - order(b.severity) || a.rule.localeCompare(b.rule));
  return {
    repo: ref.name,
    inventory: {
      sourceFiles: codeFiles.filter((f) => !isTestFile(rel(root, f))).length,
      testFiles: codeFiles.filter((f) => isTestFile(rel(root, f))).length,
      tests: tests.length,
      scenarios: scenarios.length,
    },
    findings: kept,
    ignored,
    runs,
    testSummary,
  };
}

export function auditFamily(options: AuditOptions): AuditReport {
  const now = options.now ?? new Date();
  const repos = options.repos.map((ref) => ({ ref, root: path.resolve(ref.dir) }));
  const reports = repos.map(({ ref }) => auditRepo(ref, { run: options.run, now }));
  return {
    generatedAt: now.toISOString(),
    node: process.version,
    repos: reports,
    family: familyFindings(repos),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// comparing with the previous audit, and writing the report

export interface Delta {
  added: AuditFinding[];
  resolved: AuditFinding[];
  persisting: number;
}

const key = (f: AuditFinding): string => `${f.repo}|${f.rule}|${f.file ?? ''}`;

export function allFindings(report: AuditReport): AuditFinding[] {
  return [...report.repos.flatMap((r) => r.findings), ...report.family];
}

export function compareReports(previous: AuditReport | undefined, current: AuditReport): Delta | undefined {
  if (!previous) return undefined;
  const before = new Map(allFindings(previous).map((f) => [key(f), f]));
  const after = new Map(allFindings(current).map((f) => [key(f), f]));
  return {
    added: [...after].filter(([k]) => !before.has(k)).map(([, f]) => f),
    resolved: [...before].filter(([k]) => !after.has(k)).map(([, f]) => f),
    persisting: [...after].filter(([k]) => before.has(k)).length,
  };
}

/** The most recent earlier audit.json under `outDir` (date-named folders), if any. */
export function findPreviousReport(outDir: string, currentFolder: string): AuditReport | undefined {
  if (!fs.existsSync(outDir)) return undefined;
  const folders = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name < currentFolder && fs.existsSync(path.join(outDir, e.name, 'audit.json')))
    .map((e) => e.name)
    .sort();
  const last = folders[folders.length - 1];
  return last ? readJson<AuditReport>(path.join(outDir, last, 'audit.json')) : undefined;
}

export function auditSeverityCounts(findings: AuditFinding[]): Record<AuditSeverity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<AuditSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function worstAuditSeverity(findings: AuditFinding[]): AuditSeverity | undefined {
  return AUDIT_SEVERITIES.find((s) => findings.some((f) => f.severity === s));
}

const MANUAL_CHECKLIST = [
  'Pick 5 tests at random: can each one FAIL for the reason its title claims (oracle quality)? Try breaking the behaviour.',
  'Read the last two weeks of failures: which were product defects, which framework or environment? Is each linked to a ticket?',
  'Look at flaky tests and retries in the run history: is any cause recurring (data, ordering, shared state)?',
  'Are new tests using boundary values, equivalence classes or decision tables where the rule calls for them - or only happy paths?',
  'Review the converters\' output from the last fortnight for secrets, missing assertions and TODO(converter) markers.',
  'Check the exceptions list (audit-allowlist.json, .secretscan-allow.json, .framework-audit.json): does every reason still hold?',
  'Skim the changes since the last audit for new public API without tests or a CHANGELOG entry.',
  'Open the newest pipeline run: slowest jobs, retried jobs, jobs that are allowed to fail.',
];

export function markdownAuditReport(report: AuditReport, delta?: Delta): string {
  const all = allFindings(report);
  const counts = auditSeverityCounts(all);
  const out: string[] = [];
  out.push(`# Framework audit - ${report.generatedAt.slice(0, 10)}`);
  out.push('');
  out.push(
    `Generated ${report.generatedAt} on Node ${report.node}. ${report.repos.length} repo(s). ` +
      'This is the automated part of the audit (checks that can be made from files and the repos\' own scripts). ' +
      'The judgement-based part is the checklist at the end.',
  );
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Repo | Critical | High | Medium | Low | Info | Tests | Scenarios |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const r of report.repos) {
    const c = auditSeverityCounts(r.findings);
    out.push(
      `| ${r.repo} | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} | ${c.info} | ${r.inventory.tests} | ${r.inventory.scenarios} |`,
    );
  }
  if (report.family.length > 0) {
    const c = auditSeverityCounts(report.family);
    out.push(`| (across repos) | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} | ${c.info} | | |`);
  }
  out.push(`| **Total** | **${counts.critical}** | **${counts.high}** | **${counts.medium}** | **${counts.low}** | **${counts.info}** | | |`);
  out.push('');
  if (delta) {
    out.push('## Since the previous audit');
    out.push('');
    out.push(`New: ${delta.added.length} - Resolved: ${delta.resolved.length} - Still open: ${delta.persisting}`);
    out.push('');
    for (const f of delta.added) out.push(`- NEW  [${f.severity}] ${f.repo}: ${f.title}`);
    for (const f of delta.resolved) out.push(`- DONE [${f.severity}] ${f.repo}: ${f.title}`);
    out.push('');
  }
  const section = (title: string, findings: AuditFinding[]) => {
    out.push(`## ${title}`);
    out.push('');
    if (findings.length === 0) {
      out.push('No findings.');
      out.push('');
      return;
    }
    for (const f of findings) {
      out.push(`### [${f.severity.toUpperCase()}] ${f.title}  \`${f.rule}\``);
      out.push('');
      out.push(f.detail);
      if (f.file) out.push(`\n- Where: \`${f.file}${f.line ? `:${f.line}` : ''}\`${f.count && f.count > 1 ? ` (${f.count} places)` : ''}`);
      else if (f.count) out.push(`\n- Count: ${f.count}`);
      if (f.evidence && f.evidence.length > 0) {
        out.push('');
        for (const e of f.evidence) out.push(`  - \`${e.replace(/`/g, "'")}\``);
      }
      out.push('');
    }
  };
  for (const r of report.repos) {
    section(r.repo, r.findings);
    if (r.runs.length > 0) {
      out.push(`Gates in ${r.repo}:`);
      out.push('');
      for (const run of r.runs)
        out.push(`- \`npm run ${run.script}\`: ${run.exitCode === 0 ? 'passed' : `exit ${run.exitCode}`} (${(run.durationMs / 1000).toFixed(0)}s)`);
      if (r.testSummary) {
        const s = r.testSummary;
        out.push(`- Test run: ${s.expected} passed, ${s.unexpected} failed, ${s.flaky} flaky, ${s.skipped} skipped`);
      }
      out.push('');
    }
    if (r.ignored.length > 0) {
      out.push(`Accepted exceptions in ${r.repo} (.framework-audit.json): ${r.ignored.map((i) => `${i.rule}${i.file ? ` @ ${i.file}` : ''} - ${i.reason}`).join('; ')}`);
      out.push('');
    }
  }
  if (report.family.length > 0) section('Across the repos', report.family);
  out.push('## Manual review checklist (needs a person, or the prompt in docs/governance/AUDIT_PROMPT.md)');
  out.push('');
  for (const item of MANUAL_CHECKLIST) out.push(`- [ ] ${item}`);
  out.push('');
  return out.join('\n');
}

export function writeAuditReport(report: AuditReport, outDir: string, delta?: Delta): { dir: string; markdown: string; json: string } {
  const dir = path.join(outDir, report.generatedAt.slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const markdown = path.join(dir, 'AUDIT_REPORT.md');
  const json = path.join(dir, 'audit.json');
  fs.writeFileSync(markdown, markdownAuditReport(report, delta));
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  return { dir, markdown, json };
}

/** Repos next to each other under `parent` (folders named referenced-automation-* that hold a package.json). */
export function discoverFamily(parent: string): RepoRef[] {
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('referenced-automation-'))
    .filter((e) => fs.existsSync(path.join(parent, e.name, 'package.json')))
    .map((e) => ({ name: e.name, dir: path.join(parent, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
