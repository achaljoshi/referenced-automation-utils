import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import * as yaml from 'js-yaml';

/**
 * What can be checked without a GitLab: that the template is valid YAML with the jobs it promises, wired consistently,
 * and - by running the template's own shell lines - that they do what the comments say. Every expectation is read from
 * the template itself; nothing here repeats a number that the template also contains.
 */
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'ci/templates/playwright.gitlab-ci.yml');
const template = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const repoPipeline = yaml.load(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8')) as Record<string, any>;
const scriptOf = (job: string): string[] => template[job].script as string[];
const runCli = (name: string, ...args: string[]) => spawnSync(process.execPath, [path.join(root, `dist/cli/${name}.js`), ...args], { encoding: 'utf8' });

test.describe('shared GitLab CI template', () => {
  test('defines the hidden jobs a repo extends', () => {
    for (const job of ['.automation-registry', '.automation-typecheck', '.automation-security', '.automation-test-sharded', '.automation-merge-reports']) expect(template[job], job).toBeDefined();
  });

  test('every `extends` points at a job that exists in the template', () => {
    for (const [name, job] of Object.entries(template)) {
      const extendsRef = (job as { extends?: string }).extends;
      if (extendsRef) expect(template[extendsRef], `${name} extends ${extendsRef}`).toBeDefined();
    }
  });

  test('the shard count is written once - `parallel: N` - and every shard is derived from CI_NODE_INDEX / CI_NODE_TOTAL', () => {
    const job = template['.automation-test-sharded'];
    expect(Number.isInteger(job.parallel) && job.parallel >= 2, 'parallel is a literal shard count').toBe(true);
    expect(job.parallel.matrix, 'no second, hand-written list of shards').toBeUndefined();
    expect(JSON.stringify(template.variables)).not.toContain('SHARD');
    const testLine = scriptOf('.automation-test-sharded').find((line) => line.includes('playwright test'));
    expect(testLine).toContain('--reporter=blob');

    // run the template's own command for every node GitLab would start, with `playwright test` replaced by `echo`
    const shards = Array.from({ length: job.parallel }, (_, i) => {
      const run = spawnSync('sh', ['-c', (testLine as string).replace('npx playwright test', 'echo')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', CI_NODE_INDEX: String(i + 1), CI_NODE_TOTAL: String(job.parallel) },
      });
      return /--shard=(\S+)/.exec(run.stdout)?.[1];
    });
    expect(shards).toEqual(Array.from({ length: job.parallel }, (_, i) => `${i + 1}/${job.parallel}`));
  });

  test('shards upload their blob reports and the merge job reads them from the same folder', () => {
    expect(template['.automation-test-sharded'].artifacts.paths).toContain('blob-report/');
    expect(scriptOf('.automation-merge-reports').join('\n')).toContain('merge-reports --reporter=html ./blob-report');
    expect(template['.automation-merge-reports'].artifacts.reports.junit).toBe('test-results/junit.xml');
  });

  test('the merge job runs even when a shard failed, and keeps flake history in the cache for the default branch only', () => {
    const job = template['.automation-merge-reports'];
    expect(job.when).toBe('always');
    expect(job.cache.paths).toContain('.ci-history/');
    expect(job.cache.key).toBe('automation-history-${CI_DEFAULT_BRANCH}'); // not per merge request, not one global key
    const script = scriptOf('.automation-merge-reports').join('\n');
    expect(script).toMatch(/CI_COMMIT_BRANCH.*=.*CI_DEFAULT_BRANCH.*APPEND="--append"/); // only the default branch adds to the history
  });

  test('the merge job gates on flakiness and on nothing having run, with flags that automation-run-report really has', () => {
    const script = scriptOf('.automation-merge-reports').join('\n');
    expect(script).toContain('automation-run-report');
    expect(script).toContain('--min-executed');
    expect(script).toContain('--fail-on-flaky');
    expect(template.variables.AUTOMATION_MIN_EXECUTED).toBeDefined();
    expect(template.variables.AUTOMATION_FAIL_ON_FLAKY).toBeDefined();
    const usage = runCli('runReport', '--help').stdout;
    const gateLines = scriptOf('.automation-merge-reports').filter((l) => l.includes('automation-run-report') || l.startsWith('GATES='));
    const flags = new Set(gateLines.join(' ').match(/--[a-z][a-z-]+/g));
    expect(flags.size).toBeGreaterThanOrEqual(4);
    for (const flag of flags) expect(usage, flag).toContain(flag);
  });

  test('the gate lines work: defaults pass a good report, fail an empty one and a flaky one (run for real against the CLI)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gates-'));
    const results = path.join(dir, 'results.json');
    const gateLine = scriptOf('.automation-merge-reports').find((l) => l.startsWith('GATES='));
    const run = (report: object, vars: Record<string, string>) => {
      fs.writeFileSync(results, JSON.stringify(report));
      const sh = [gateLine, `node ${path.join(root, 'dist/cli/runReport.js')} --input ${results} --out ${dir}/r.md $GATES`].join('\n');
      return spawnSync('sh', ['-c', sh], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...Object.fromEntries(Object.entries(template.variables).filter(([k]) => k.startsWith('AUTOMATION_'))), ...vars } });
    };
    const one = (status: string, results_: object[]) => ({ suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 't', file: 'a.spec.ts', tests: [{ projectName: 'chromium', status, results: results_ }] }] }] });
    expect(run(one('expected', [{ status: 'passed', duration: 1, retry: 0 }]), {}).status).toBe(0);
    expect(run({ suites: [] }, {}).status).toBe(1); // nothing ran
    expect(run(one('flaky', [{ status: 'failed', duration: 1, retry: 0 }, { status: 'passed', duration: 1, retry: 1 }]), { AUTOMATION_FAIL_ON_FLAKY: '1' }).status).toBe(1);
    expect(run(one('flaky', [{ status: 'failed', duration: 1, retry: 0 }, { status: 'passed', duration: 1, retry: 1 }]), { AUTOMATION_FAIL_ON_FLAKY: '0' }).status).toBe(0); // 0 turns the flaky gate off
  });

  test('typecheck is a job of its own, and runs the repo\'s typecheck script', () => {
    const job = template['.automation-typecheck'];
    expect(job.extends).toBe('.automation-registry');
    expect(job.script.join('\n')).toContain('npm run typecheck');
  });

  test('the security job BLOCKS on a finding: only exit code 2 ("could not run") may fail without stopping the pipeline', () => {
    const job = template['.automation-security'];
    expect(job.allow_failure).toEqual({ exit_codes: 2 });
    expect(job.script.join('\n')).toMatch(/automation-scan-secrets[\s\S]*automation-audit-gate/);
    // and the audit tool really uses 2 for "could not run" and 1 for "gate failed"
    expect(runCli('auditGate', '--help').stdout).toMatch(/1\s+the gate failed[\s\S]*2\s+the audit could not run/);
  });

  test('no registry address, token or credential is hardcoded: they come from CI variables', () => {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/https?:\/\/(?!github|gitlab\.com|playwright)/); // only documentation links, no internal hosts
    expect(text).toContain('NPM_REGISTRY_URL');
  });

  test('the comments make no claim the template contradicts (siblings are installed from the registry, not built in before_script)', () => {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/before_script.*sibling|sibling.*before_script|built (first|in)/i);
    expect(text).not.toContain('AUTOMATION_SHARDS');
  });
});

test.describe('this repository\'s own pipeline', () => {
  test('the build job type-checks (tests included) as well as building and linting', () => {
    const script = (repoPipeline.build.script as string[]).join('\n');
    for (const step of ['npm run build', 'npm run lint', 'npm run typecheck']) expect(script, step).toContain(step);
  });

  test('the security job only tolerates exit code 2', () => {
    expect(repoPipeline.security.allow_failure).toEqual({ exit_codes: 2 });
  });
});
