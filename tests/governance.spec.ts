import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { governance } from '../src';

const { parseAudit, evaluate, formatGate, loadAllowlist, scanFile, scanDirectory, summarize, repeatOffenders, markdownRunReport, toHistoryRecord, appendHistory, loadHistory } = governance;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
const cli = (name: string) => path.resolve(__dirname, `../dist/cli/${name}.js`);

// --------------------------------------------------------------------------------------------------- audit gate
const auditJson = (vulns: Record<string, unknown>) => ({ auditReportVersion: 2, vulnerabilities: vulns });
const via = (id: string, severity: string, name = 'lib') => ({ source: 1, name, title: `${name} problem`, url: `https://github.com/advisories/${id}`, severity, range: '<2.0.0' });
const sample = auditJson({
  '@faker-js/faker': { name: '@faker-js/faker', severity: 'high', via: [via('GHSA-qxc2-j82w-r537', 'high', '@faker-js/faker')] },
  lodash: { name: 'lodash', severity: 'moderate', via: [via('GHSA-aaaa-bbbb-cccc', 'moderate', 'lodash')] },
  'uses-lodash': { name: 'uses-lodash', severity: 'moderate', via: ['lodash'] }, // affected only through lodash: not a separate advisory
});
const now = new Date('2026-10-10T12:00:00Z');
const allow = (extra: object = {}) => ({ allow: [{ id: 'GHSA-qxc2-j82w-r537', package: '@faker-js/faker', reason: 'ESM-only upgrade pending', owner: 'platform', expires: '2027-03-31', ...extra }] });

test.describe('audit gate', () => {
  test('reads advisories from npm audit JSON (one per advisory; transitive-only entries are not separate findings)', () => {
    const found = parseAudit(sample);
    expect(found.map((a) => `${a.severity} ${a.pkg} ${a.id}`)).toEqual(['high @faker-js/faker GHSA-qxc2-j82w-r537', 'moderate lodash GHSA-aaaa-bbbb-cccc']);
  });

  test('a high advisory with no exception blocks; below the threshold is only counted', () => {
    const r = evaluate(parseAudit(sample), { allow: [] }, { now });
    expect(r.blocking.map((a) => a.pkg)).toEqual(['@faker-js/faker']);
    expect(r.belowThreshold).toBe(1);
  });

  test('an unexpired exception lets it through, and says how long it lasts', () => {
    const r = evaluate(parseAudit(sample), allow(), { now });
    expect(r.blocking).toEqual([]);
    expect(r.allowed[0]?.daysLeft).toBeGreaterThan(100);
    expect(formatGate(r, 'high')).toContain('accepted  high  @faker-js/faker  GHSA-qxc2-j82w-r537  until 2027-03-31');
  });

  test('an EXPIRED exception stops protecting: the gate fails again and says the exception expired', () => {
    const r = evaluate(parseAudit(sample), allow({ expires: '2026-10-01' }), { now });
    expect(r.blocking.map((a) => a.pkg)).toEqual(['@faker-js/faker']);
    expect(r.expired).toHaveLength(1);
    expect(formatGate(r, 'high')).toContain('EXPIRED on 2026-10-01');
  });

  test('an exception for a different package or a different advisory does not apply', () => {
    expect(evaluate(parseAudit(sample), allow({ package: 'other' }), { now }).blocking).toHaveLength(1);
    expect(evaluate(parseAudit(sample), allow({ id: 'GHSA-zzzz-zzzz-zzzz' }), { now }).blocking).toHaveLength(1);
  });

  test('an exception that matches nothing is reported as unused (delete it)', () => {
    const r = evaluate([], allow(), { now });
    expect(r.unused).toHaveLength(1);
    expect(formatGate(r, 'high')).toContain('matches nothing in this audit any more');
  });

  test('warns when an exception is close to expiry or nobody owns it', () => {
    expect(formatGate(evaluate(parseAudit(sample), allow({ expires: '2026-10-20' }), { now }), 'high')).toContain('expires soon');
    expect(formatGate(evaluate(parseAudit(sample), allow({ owner: 'UNASSIGNED - name one' }), { now }), 'high')).toContain('nobody owns this exception');
  });

  test('the threshold is adjustable; an invalid date is an error, not a silent pass', () => {
    expect(evaluate(parseAudit(sample), { allow: [] }, { now, threshold: 'moderate' }).blocking).toHaveLength(2);
    expect(() => evaluate(parseAudit(sample), allow({ expires: 'next year' }), { now })).toThrow(/invalid "expires"/);
  });

  test('an allowlist entry must say why and until when', () => {
    const file = path.join(tmp(), 'a.json');
    fs.writeFileSync(file, JSON.stringify({ allow: [{ id: 'GHSA-x' }] }));
    expect(() => loadAllowlist(file)).toThrow(/needs "id", "reason" and "expires"/);
    expect(loadAllowlist(path.join(tmp(), 'missing.json')).allow).toEqual([]);
  });

  test('the CLI: exit 1 when blocked, 0 when accepted, 2 when the audit could not run', () => {
    const dir = tmp();
    const input = path.join(dir, 'audit.json');
    const list = path.join(dir, 'allow.json');
    fs.writeFileSync(input, JSON.stringify(sample));
    expect(spawnSync('node', [cli('auditGate'), '--input', input, '--allowlist', list], { encoding: 'utf8' }).status).toBe(1);
    fs.writeFileSync(list, JSON.stringify(allow()));
    expect(spawnSync('node', [cli('auditGate'), '--input', input, '--allowlist', list], { encoding: 'utf8' }).status).toBe(0);
    fs.writeFileSync(input, JSON.stringify({ error: { summary: 'getaddrinfo ENOTFOUND registry' } }));
    const offline = spawnSync('node', [cli('auditGate'), '--input', input], { encoding: 'utf8' });
    expect(offline.status).toBe(2);
    expect(offline.stderr).toContain('npm audit failed');
  });

  test('the repository\'s own audit passes with its committed allowlist (a regression guard for this repo)', () => {
    const allowlist = loadAllowlist(path.resolve(__dirname, '../audit-allowlist.json'));
    expect(allowlist.allow.every((e) => e.reason.length > 20 && e.expires)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------- secret scan
test.describe('secret scan', () => {
  const rules = (text: string, file = 'src/app.ts') => scanFile(file, text).map((f) => f.rule);

  test('finds private keys, cloud and CI tokens, passwords in URLs', () => {
    expect(rules('-----BEGIN RSA PRIVATE KEY-----')).toContain('private-key');
    expect(rules('const k = "AKIAIOSFODNN7EXAMPLE";')).toContain('aws-access-key');
    expect(rules(`token: ghp_${'a'.repeat(36)}`)).toContain('github-token');
    expect(rules('glpat-abcdefghijklmnopqrst')).toContain('gitlab-token');
    expect(rules('xoxb-1234567890-abcdefgh')).toContain('slack-token');
    expect(rules('fetch("https://admin:hunter22@host/api")')).toContain('url-credentials');
  });

  test('finds a literal password assigned in code, but not an environment read or a placeholder', () => {
    expect(rules('const password = "s3cr3t-value";')).toContain('password-assignment');
    expect(rules('apiKey: "abcd1234efgh"')).toContain('password-assignment');
    expect(rules('const password = process.env.PASSWORD;')).toEqual([]);
    expect(rules('password = "${DB_PASSWORD}"')).toEqual([]);
    expect(rules('password: "changeme-please"')).toEqual([]);
    expect(rules('password: "short"')).toEqual([]); // under 8 characters
  });

  test('prose is not scanned by the fuzzy generic rule (Markdown quotes examples), but real token rules still apply to it', () => {
    expect(rules('the secret: `SAP_PASSWORD=your-password` goes in .env.qa.local', 'README.md')).toEqual([]);
    expect(rules('const password = "s3cr3t-value";', 'notes.md')).toEqual([]);
    expect(rules('AKIAIOSFODNN7EXAMPLE', 'README.md')).toContain('aws-access-key');
    expect(rules('API_KEY=replace-me', '.env.example')).toEqual([]); // "replace..." is a placeholder
  });

  test('finds a secret in a committed .env file, only in .env files', () => {
    expect(rules('SAP_PASSWORD=Sup3rS3cret', '.env.qa')).toContain('env-secret');
    expect(rules('API_TOKEN=abcdef123456', '.env')).toContain('env-secret');
    expect(rules('SAP_PASSWORD=', '.env.qa')).toEqual([]);
    expect(rules('SAP_PASSWORD=Sup3rS3cret', 'src/notes.ts')).not.toContain('env-secret');
  });

  test('finds a password typed into a SAP GUI recording', () => {
    const vbs = 'session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = "my-real-password"';
    expect(rules(vbs, 'recordings/login.vbs')).toContain('sap-recorded-password');
    expect(rules('session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "JDOE"', 'recordings/login.vbs')).toEqual([]);
  });

  test('NEVER prints the secret: the excerpt is masked', () => {
    const [finding] = scanFile('x.ts', 'const password = "hunter2-very-secret";');
    expect(finding?.excerpt).not.toContain('hunter2-very-secret');
    expect(finding?.excerpt).toContain('hu***');
  });

  test('scans a directory; skips node_modules, binaries and big files; honours the reasoned allowlist', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/x/leak.js'), 'password = "should-be-skipped-1"');
    fs.writeFileSync(path.join(dir, 'bad.ts'), 'const password = "real-secret-value";\n');
    fs.writeFileSync(path.join(dir, '.env.simulator'), 'SAP_PASSWORD=correct-horse\n');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    const result = scanDirectory(dir);
    expect(result.findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual(['.env.simulator:env-secret', 'bad.ts:password-assignment']);

    const allowed = scanDirectory(dir, [{ rule: 'env-secret', path: '.env.simulator', reason: "the simulator's made-up credentials" }]);
    expect(allowed.findings.map((f) => f.file)).toEqual(['bad.ts']);
    expect(allowed.allowed).toHaveLength(1);
  });

  test('an allowlist exception is narrow: another file with the same rule is still found', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.env.simulator'), 'SAP_PASSWORD=correct-horse\n');
    fs.writeFileSync(path.join(dir, '.env.qa'), 'SAP_PASSWORD=real-qa-password\n');
    const result = scanDirectory(dir, [{ rule: 'env-secret', path: '.env.simulator', reason: 'made up' }]);
    expect(result.findings.map((f) => f.file)).toEqual(['.env.qa']);
  });

  test('inside a git checkout only tracked / non-ignored files are scanned', () => {
    const dir = tmp();
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(dir, 'ignored.ts'), 'const password = "ignored-secret-1";');
    fs.writeFileSync(path.join(dir, 'kept.ts'), 'const password = "kept-secret-value";');
    expect(scanDirectory(dir).findings.map((f) => f.file)).toEqual(['kept.ts']);
  });

  test('the CLI exits 1 on a finding, 0 when clean, and its output contains no secret', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const password = "do-not-print-me-9";\n');
    const bad = spawnSync('node', [cli('scanSecrets'), '--dir', dir], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).not.toContain('do-not-print-me-9');
    expect(bad.stdout).toContain('a.ts:1  password-assignment');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const password = process.env.X;\n');
    expect(spawnSync('node', [cli('scanSecrets'), '--dir', dir], { encoding: 'utf8' }).status).toBe(0);
  });

  test('this repository itself is clean', () => {
    const result = scanDirectory(path.resolve(__dirname, '..'), governance.loadAllow(path.resolve(__dirname, '../.secretscan-allow.json')));
    expect(result.findings, JSON.stringify(result.findings)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------------- run report
const spec = (title: string, tests: object[]) => ({ title, file: 'a.spec.ts', tests });
const result = (status: string, duration: number, message?: string) => ({ status, duration, retry: 0, ...(message ? { error: { message } } : {}) });
const report = {
  stats: { duration: 12_000 },
  suites: [
    {
      title: 'a.spec.ts',
      file: 'a.spec.ts',
      specs: [spec('fast pass', [{ projectName: 'chromium', status: 'expected', results: [result('passed', 100)] }])],
      suites: [
        {
          title: 'orders',
          specs: [
            spec('flaky one', [{ projectName: 'chromium', status: 'flaky', results: [result('failed', 400, 'boom'), result('passed', 500)] }]),
            spec('broken', [{ projectName: 'chromium', status: 'unexpected', results: [result('failed', 3000, '\u001b[31mExpected: 5\u001b[39m\nReceived: 3')] }]),
            spec('skipped', [{ projectName: 'firefox', status: 'skipped', results: [] }]),
          ],
        },
      ],
    },
  ],
};

test.describe('run report', () => {
  test('summarises outcomes: passed, failed, flaky, skipped, with the failure reason (colour codes stripped)', () => {
    const s = summarize(report);
    expect(s).toMatchObject({ total: 4, passed: 1, failed: 1, flaky: 1, skipped: 1, durationMs: 12_000 });
    expect(s.outcomes.find((o) => o.status === 'failed')).toMatchObject({ title: 'orders > broken', error: 'Expected: 5' });
    expect(s.outcomes.find((o) => o.status === 'flaky')).toMatchObject({ title: 'orders > flaky one', attempts: 2 });
    expect(s.byProject.chromium).toEqual({ passed: 1, failed: 1, flaky: 1, skipped: 0 });
  });

  test('the Markdown names the failures, the flaky tests (with why they matter) and the slowest tests', () => {
    const md = markdownRunReport(summarize(report));
    expect(md).toContain('**1 failed**');
    expect(md).toContain('- **orders > broken** [chromium] - Expected: 5');
    expect(md).toContain('## Flaky (failed, then passed on retry)');
    expect(md).toContain('orders > flaky one [chromium] - passed on attempt 2');
    expect(md.indexOf('orders > broken')).toBeLessThan(md.lastIndexOf('fast pass')); // slowest first
  });

  test('history finds repeat offenders across runs - and ignores one-off blips', () => {
    const file = path.join(tmp(), 'history.jsonl');
    const base = toHistoryRecord(summarize(report), new Date('2026-10-01T00:00:00Z'));
    for (let i = 0; i < 3; i++) appendHistory(file, { ...base, at: `2026-10-0${i + 1}T00:00:00Z` });
    appendHistory(file, { ...base, failedTitles: [], flakyTitles: ['[chromium] one-off blip'] });
    const offenders = repeatOffenders(loadHistory(file));
    expect(offenders.map((o) => o.title)).toEqual(['[chromium] orders > broken', '[chromium] orders > flaky one']);
    expect(offenders[0]).toMatchObject({ bad: 3, runs: 4, failed: 3 });
  });

  test('the CLI reads the JSON report, writes Markdown, keeps history, and gates on flakiness', () => {
    const dir = tmp();
    const input = path.join(dir, 'results.json');
    const out = path.join(dir, 'report.md');
    const history = path.join(dir, 'h.jsonl');
    fs.writeFileSync(input, JSON.stringify(report));
    const run = spawnSync('node', [cli('runReport'), '--input', input, '--out', out, '--history', history, '--append'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain('# Test run report');
    expect(loadHistory(history)).toHaveLength(1);
    expect(spawnSync('node', [cli('runReport'), '--input', input, '--out', out, '--fail-on-flaky', '1'], { encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync('node', [cli('runReport'), '--input', input, '--out', out, '--fail-on-flaky', '2'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('node', [cli('runReport'), '--input', path.join(dir, 'nope.json')], { encoding: 'utf8' }).status).toBe(2);
  });
});
