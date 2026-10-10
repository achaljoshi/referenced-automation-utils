import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { governance } from '../src';

const { auditRepo, auditFamily, codeViews, compareReports, findPreviousReport, markdownAuditReport, writeAuditReport, discoverFamily } = governance;
const cli = path.resolve(__dirname, '../dist/cli/frameworkAudit.js');
const now = new Date('2026-10-10T12:00:00Z');

/** A throwaway repo: every file given as { 'relative/path': 'content' }. */
function repo(files: Record<string, string>, name = 'sample'): { root: string; ref: { name: string; dir: string } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const dir = path.join(root, name);
  const all: Record<string, string> = { 'package.json': '{"name":"x","scripts":{}}', 'package-lock.json': '{}', ...files };
  for (const [file, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return { root, ref: { name, dir } };
}
const ids = (r: ReturnType<typeof auditRepo>) => r.findings.map((f) => f.rule);

test.describe('code rules', () => {
  test('flag real hard waits, only, skips, force, non-web-first assertions and open listeners - with file:line evidence', () => {
    const { ref } = repo({
      'tests/bad.spec.ts': [
        "import { test, expect } from '@playwright/test';",
        "test.only('a', async ({ page }) => {",
        '  await page.waitForTimeout(500);',
        "  await page.waitForLoadState('networkidle');",
        "  await page.click('#x', { force: true });",
        "  expect(await page.isVisible('#x')).toBe(true);",
        '  await new Promise((r) => setTimeout(r, 100));',
        '});',
        "test.skip('later', async () => {});",
        "test.describe.configure({ mode: 'serial' });",
        "server.listen(0, () => {});",
        'expect(() => run()).toThrow();',
      ].join('\n'),
    });
    const r = auditRepo(ref, { now });
    expect(ids(r)).toEqual(
      expect.arrayContaining([
        'wait-fixed',
        'wait-networkidle',
        'test-only',
        'test-skipped',
        'force-action',
        'assert-not-web-first',
        'sleep-promise',
        'serial-mode',
        'listen-all-interfaces',
        'assert-weak-throw',
      ]),
    );
    const wait = r.findings.find((f) => f.rule === 'wait-fixed');
    expect(wait?.severity).toBe('high');
    expect(wait?.file).toBe('tests/bad.spec.ts');
    expect(wait?.line).toBe(3);
    expect(wait?.evidence?.[0]).toContain('tests/bad.spec.ts:3');
  });

  test('text that merely MENTIONS a pattern is not flagged: comments, strings, template literals, fs deletes, conditional skips', () => {
    const { ref } = repo({
      'tests/fine.spec.ts': [
        "import { test } from '@playwright/test';",
        '// page.waitForTimeout(500) is banned',
        '/* test.only( is banned too */',
        "const message = 'page.waitForTimeout(3000) was removed';",
        'const fixture = `',
        "  await page.waitForLoadState('networkidle');",
        '  await page.waitForTimeout(3000);',
        '`;',
        'await fs.promises.rm(dir, { recursive: true, force: true });',
        "test.skip(process.platform === 'win32', 'unix only');",
        "server.listen(0, '127.0.0.1');",
        "test('ok', async () => {});",
      ].join('\n'),
    });
    expect(ids(auditRepo(ref, { now })).filter((id) => /^(?:wait|test-|force|listen|sleep)/.test(id))).toEqual([]);
  });

  test('the repo\'s own waiting helper, lint-rule text and raw recordings are not flagged; a listen with a host string is not flagged', () => {
    const { ref } = repo({
      'tests/helper.spec.ts': "expect(await actions.isVisible(locator)).toBe(true);\nserver.listen(0, '127.0.0.1', () => {});",
      '.eslintrc.cjs': "module.exports = { rules: { 'no-restricted-syntax': [{ selector: \"Literal[value='networkidle']\" }] } };",
      'recordings/raw.spec.ts': 'await page.waitForTimeout(500);',
    });
    expect(ids(auditRepo(ref, { now })).filter((id) => /^(?:wait|assert-not|listen)/.test(id))).toEqual([]);
  });

  test('the tokenizer keeps line numbers and blanks only what it should', () => {
    const views = codeViews("a(); // c\nb('x');\n`t\n u`;\nc();");
    expect(views.code).toHaveLength(5);
    expect(views.code[0]).toBe('a();     ');
    expect(views.code[1]).toBe("b('_');");
    expect(views.literals[1]).toBe("b('x');");
    expect(views.code[3]).toBe('__`;');
    expect(views.code[4]).toBe('c();');
  });
});

test.describe('exceptions', () => {
  const bad = { 'tests/w.spec.ts': 'await page.waitForTimeout(1);' };

  test('an exception with a reason removes the finding and is listed in the report', () => {
    const { ref } = repo({ ...bad, '.framework-audit.json': JSON.stringify({ ignore: [{ rule: 'wait-fixed', path: 'tests/', reason: 'legacy page, ticket 123' }] }) });
    const r = auditRepo(ref, { now });
    expect(ids(r)).not.toContain('wait-fixed');
    expect(r.ignored).toEqual([{ rule: 'wait-fixed', file: 'tests/w.spec.ts', reason: 'legacy page, ticket 123' }]);
  });

  test('an expired exception no longer applies, and a path that does not match does not apply', () => {
    const expired = repo({ ...bad, '.framework-audit.json': JSON.stringify({ ignore: [{ rule: 'wait-fixed', reason: 'x', expires: '2026-01-01' }] }) });
    expect(ids(auditRepo(expired.ref, { now }))).toContain('wait-fixed');
    const other = repo({ ...bad, '.framework-audit.json': JSON.stringify({ ignore: [{ rule: 'wait-fixed', path: 'src/', reason: 'x' }] }) });
    expect(ids(auditRepo(other.ref, { now }))).toContain('wait-fixed');
  });
});

test.describe('traceability and tags', () => {
  const tests = (n: number, withReq: number) =>
    Array.from({ length: n }, (_, i) => `test('case ${i} ${i < withReq ? '@REQ-' + (100 + i) : ''} @smoke', async () => {});`).join('\n');

  test('no requirement ids anywhere is a finding; enough of them is not', () => {
    expect(ids(auditRepo(repo({ 'tests/a.spec.ts': tests(12, 0) }).ref, { now }))).toContain('traceability');
    expect(ids(auditRepo(repo({ 'tests/a.spec.ts': tests(12, 8) }).ref, { now }))).not.toContain('traceability');
  });

  test('Gherkin scenarios count too, with feature-level and scenario-level tags', () => {
    const feature = ['@REQ-1', 'Feature: f', ...Array.from({ length: 12 }, (_, i) => `  @smoke\n  Scenario: s${i}\n    Given x`)].join('\n');
    const r = auditRepo(repo({ 'features/a.feature': feature }).ref, { now });
    expect(r.inventory.scenarios).toBe(12);
    expect(ids(r)).not.toContain('traceability');
    expect(ids(r)).not.toContain('tags');
  });

  test('a suite with neither @smoke nor @regression gets a tags finding', () => {
    const r = auditRepo(repo({ 'tests/a.spec.ts': Array.from({ length: 12 }, (_, i) => `test('c${i}', async () => {});`).join('\n') }).ref, { now });
    expect(ids(r)).toContain('tags');
  });
});

test.describe('dependencies and governance', () => {
  test('a file: or .tgz @automation dependency, a ranged playwright-bdd and a missing lockfile are findings', () => {
    const { root, ref } = repo({
      'package.json': JSON.stringify({ dependencies: { '@automation/x': 'file:../shared-packages/x.tgz' }, devDependencies: { 'playwright-bdd': '^9.2.1' } }),
    });
    fs.rmSync(path.join(ref.dir, 'package-lock.json'));
    const r = auditRepo(ref, { now });
    expect(ids(r)).toEqual(expect.arrayContaining(['dep-local-package', 'dep-bdd-not-pinned', 'dep-no-lockfile']));
    expect(r.findings.find((f) => f.rule === 'dep-local-package')?.severity).toBe('high');
    void root;
  });

  test('CODEOWNERS, accepted advisories without an owner, expired and soon-to-expire ones, unapproved ADRs', () => {
    const { ref } = repo({
      'audit-allowlist.json': JSON.stringify({
        allow: [
          { id: 'A1', owner: 'UNASSIGNED - name one', expires: '2027-12-31' },
          { id: 'A2', owner: 'platform', expires: '2026-10-01' },
          { id: 'A3', owner: 'platform', expires: '2026-10-25' },
        ],
      }),
      'docs/adr/0001-x.md': '- **Approved by:** _not yet recorded_\n',
    });
    const r = auditRepo(ref, { now });
    expect(ids(r)).toEqual(expect.arrayContaining(['gov-codeowners', 'gov-allowlist-owner', 'gov-allowlist-expired', 'gov-allowlist-expiring', 'gov-adr-approval']));
    const withOwners = repo({ CODEOWNERS: '* @team' });
    expect(ids(auditRepo(withOwners.ref, { now }))).not.toContain('gov-codeowners');
  });
});

test.describe('pipeline rules', () => {
  const pkg = JSON.stringify({ scripts: { typecheck: 'tsc', test: 'bddgen && playwright test' } });

  test('a non-blocking security job, no typecheck step, features never generated, an unmatched image without an install', () => {
    const { ref } = repo({
      'package.json': pkg,
      'features/a.feature': 'Feature: f\n  Scenario: s\n    Given x',
      'node_modules/@playwright/test/package.json': '{"version":"1.64.0"}',
      '.gitlab-ci.yml': ['image: registry/playwright:v1.47.0-jammy', 'build:', '  script:', '    - npm ci', 'security:', '  allow_failure: true', '  script:', '    - npx automation-scan-secrets'].join('\n'),
    });
    const r = auditRepo(ref, { now });
    expect(ids(r)).toEqual(expect.arrayContaining(['ci-security-nonblocking', 'ci-no-typecheck', 'ci-bdd-not-generated', 'ci-image-mismatch', 'ci-no-shared-template']));
    expect(r.findings.find((f) => f.rule === 'ci-image-mismatch')?.severity).toBe('high');
  });

  test('a pipeline that does it right is not flagged (exit-code allow_failure, typecheck, npm test runs bddgen, browser install, include)', () => {
    const { ref } = repo({
      'package.json': pkg,
      'features/a.feature': 'Feature: f\n  Scenario: s\n    Given x',
      'node_modules/@playwright/test/package.json': '{"version":"1.64.0"}',
      '.gitlab-ci.yml': [
        'include:',
        '  - project: g/utils',
        'image: registry/playwright:v1.47.0-jammy',
        'test:',
        '  script:',
        '    - npm run typecheck',
        '    - npx playwright install chromium',
        '    - npm test',
        'security:',
        '  allow_failure:',
        '    exit_codes: 2',
        '  script:',
        '    - npm run security',
      ].join('\n'),
    });
    const r = auditRepo(ref, { now });
    expect(ids(r).filter((id) => id.startsWith('ci-') && id !== 'ci-image-mismatch')).toEqual([]);
    expect(r.findings.find((f) => f.rule === 'ci-image-mismatch')?.severity).toBe('info');
  });

  test('a repo with no pipeline file is a finding', () => {
    expect(ids(auditRepo(repo({}).ref, { now }))).toContain('ci-missing');
  });
});

test.describe('docs', () => {
  test('broken file links and headings, retired procedures, an image the pipeline does not use; CHANGELOG is exempt', () => {
    const { ref } = repo({
      'README.md': [
        '# T',
        '## Real heading',
        '[ok](#real-heading) [bad](#missing) [gone](docs/none.md) [web](https://example.com/x)',
        'Install with file:../shared-packages/x.tgz',
        'CI uses mcr.microsoft.com/playwright:v1.62.1-noble.',
        '```',
        '[inside](a-fence-is-ignored.md)',
        '```',
      ].join('\n'),
      'CHANGELOG.md': 'Dropped file:../shared-packages\n',
      '.gitlab-ci.yml': 'image: mirror/playwright:v1.47.0-jammy\n',
    });
    const r = auditRepo(ref, { now });
    const broken = r.findings.find((f) => f.rule === 'doc-broken-link');
    expect(broken?.count).toBe(2);
    expect(broken?.evidence?.join('\n')).toContain('(no such heading)');
    expect(broken?.evidence?.join('\n')).toContain('(no such file)');
    expect(broken?.evidence?.join('\n')).not.toContain('a-fence-is-ignored');
    const stale = r.findings.find((f) => f.rule === 'doc-stale-phrase');
    expect(stale?.count).toBe(1);
    expect(stale?.evidence?.[0]).toContain('README.md:4');
    expect(ids(r)).toContain('doc-image-mismatch');
  });

  test('the retired phrases are configurable per repo', () => {
    const { ref } = repo({ 'README.md': 'Use the old-tool.\nfile:../shared-packages is fine here\n', '.framework-audit.json': JSON.stringify({ staleDocPhrases: ['old-tool'] }) });
    const stale = auditRepo(ref, { now }).findings.find((f) => f.rule === 'doc-stale-phrase');
    expect(stale?.count).toBe(1);
  });
});

test.describe('across repos', () => {
  const withPlaywright = (version: string, extra: Record<string, string> = {}) => ({
    'node_modules/@playwright/test/package.json': JSON.stringify({ version }),
    ...extra,
  });
  const spec = Array.from({ length: 12 }, (_, i) => `test('same line number ${i}', async () => { await doThing(${i}); });`).join('\n');

  test('different Playwright versions and duplicated tests are flagged', () => {
    const a = repo({ ...withPlaywright('1.64.0'), 'tests/utilsMethods.spec.ts': spec }, 'referenced-automation-a');
    const b = repo({ ...withPlaywright('1.62.1'), 'tests/utilsMethods.spec.ts': spec }, 'referenced-automation-b');
    const report = auditFamily({ repos: [a.ref, b.ref], now });
    expect(report.family.map((f) => f.rule)).toEqual(expect.arrayContaining(['family-version-drift', 'family-duplicated-tests']));
    expect(report.family.find((f) => f.rule === 'family-version-drift')?.evidence).toEqual(['referenced-automation-a=1.64.0', 'referenced-automation-b=1.62.1']);
  });

  test('matching versions and different tests are not flagged; a single repo has no family findings', () => {
    const a = repo({ ...withPlaywright('1.64.0'), 'tests/one.spec.ts': spec }, 'referenced-automation-a');
    const b = repo({ ...withPlaywright('1.64.0'), 'tests/one.spec.ts': spec.replace(/same line number/g, 'completely different words here') }, 'referenced-automation-b');
    expect(auditFamily({ repos: [a.ref, b.ref], now }).family).toEqual([]);
    expect(auditFamily({ repos: [a.ref], now }).family).toEqual([]);
  });

  test('discoverFamily finds the referenced-automation-* repos next to each other', () => {
    const a = repo({}, 'referenced-automation-x');
    fs.mkdirSync(path.join(a.root, 'unrelated'));
    fs.writeFileSync(path.join(a.root, 'unrelated', 'package.json'), '{}');
    expect(discoverFamily(a.root).map((r) => r.name)).toEqual(['referenced-automation-x']);
  });
});

test.describe('running the repo\'s own gates and reporting', () => {
  test('--run style: a failing script is a high finding, an unreachable security gate only medium, zero executed tests is flagged', () => {
    const { ref } = repo({
      'package.json': JSON.stringify({
        scripts: { lint: 'node -e "process.exit(1)"', typecheck: 'node -e "0"', security: 'node -e "process.exit(2)"', test: 'node -e "0"' },
      }),
      'test-results/results.json': JSON.stringify({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }),
    });
    const r = auditRepo(ref, { run: true, now });
    expect(r.runs.map((x) => `${x.script}:${x.exitCode}`)).toEqual(['lint:1', 'typecheck:0', 'test:0', 'security:2']);
    expect(r.findings.find((f) => f.rule === 'run-lint')?.severity).toBe('high');
    expect(r.findings.find((f) => f.rule === 'run-security')?.severity).toBe('medium');
    expect(ids(r)).toContain('run-zero-executed');
  });

  test('flaky and skipped tests from the JSON report are reported', () => {
    const { ref } = repo({
      'package.json': JSON.stringify({ scripts: { test: 'node -e "0"' } }),
      'test-results/results.json': JSON.stringify({ stats: { expected: 90, unexpected: 0, flaky: 3, skipped: 2 } }),
    });
    const r = auditRepo(ref, { run: true, now });
    expect(r.testSummary).toEqual({ expected: 90, unexpected: 0, flaky: 3, skipped: 2 });
    expect(ids(r)).toEqual(expect.arrayContaining(['run-flaky', 'run-skipped']));
  });

  test('the delta against the previous report lists new, resolved and persisting findings; the report ends with the manual checklist', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-out-'));
    const first = repo({ 'tests/w.spec.ts': 'await page.waitForTimeout(1);' });
    const before = auditFamily({ repos: [first.ref], now: new Date('2026-09-26T09:00:00Z') });
    writeAuditReport(before, outDir);
    fs.writeFileSync(path.join(first.ref.dir, 'tests/w.spec.ts'), "test.only('x', async () => {});");
    const after = auditFamily({ repos: [first.ref], now });
    const previous = findPreviousReport(outDir, '2026-10-10');
    expect(previous?.generatedAt).toBe('2026-09-26T09:00:00.000Z');
    const delta = compareReports(previous, after);
    expect(delta?.added.map((f) => f.rule)).toContain('test-only');
    expect(delta?.resolved.map((f) => f.rule)).toContain('wait-fixed');
    const md = markdownAuditReport(after, delta);
    expect(md).toContain('## Since the previous audit');
    expect(md).toContain('NEW  [high] sample: test.only / describe.only left in code');
    expect(md).toContain('DONE [high] sample: Fixed wait (waitForTimeout)');
    expect(md).toContain('- [ ] Pick 5 tests at random');
    expect(compareReports(undefined, after)).toBeUndefined();
    expect(findPreviousReport(outDir, '2026-09-26')).toBeUndefined();
  });
});

test.describe('the command line', () => {
  const run = (args: string[], cwd?: string) => spawnSync('node', [cli, ...args], { encoding: 'utf8', cwd });

  test('writes the report and exits 0 by default; --fail-on high exits 1 when a high finding exists; a bad --fail-on is a usage error', () => {
    const { ref } = repo({ 'tests/w.spec.ts': 'await page.waitForTimeout(1);' });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
    const ok = run(['--repo', ref.dir, '--out', out]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('AUDIT_REPORT.md');
    const dated = fs.readdirSync(out)[0] as string;
    expect(fs.readFileSync(path.join(out, dated, 'AUDIT_REPORT.md'), 'utf8')).toContain('wait-fixed');
    expect(fs.existsSync(path.join(out, dated, 'audit.json'))).toBe(true);
    const failing = run(['--repo', ref.dir, '--out', out, '--fail-on', 'high']);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('audit failed: found high');
    const usage = run(['--repo', ref.dir, '--out', out, '--fail-on', 'bogus']);
    expect(usage.status).toBe(2);
  });

  test('--family audits every referenced-automation-* repo in a folder; --help describes the options', () => {
    const a = repo({}, 'referenced-automation-one');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
    const family = run(['--family', a.root, '--out', out]);
    expect(family.status).toBe(0);
    expect(family.stdout).toContain('referenced-automation-one:');
    expect(run(['--help']).stdout).toContain('the fortnightly framework audit');
  });
});
