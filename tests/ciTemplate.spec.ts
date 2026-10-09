import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import * as yaml from 'js-yaml';

/** What can be checked without a GitLab: that the template is valid YAML with the jobs it promises, wired consistently. */
const file = path.resolve(__dirname, '../ci/templates/playwright.gitlab-ci.yml');
const template = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, any>;

test.describe('shared GitLab CI template', () => {
  test('defines the hidden jobs a repo extends', () => {
    for (const job of ['.automation-registry', '.automation-security', '.automation-test-sharded', '.automation-merge-reports']) expect(template[job], job).toBeDefined();
  });

  test('every `extends` points at a job that exists in the template', () => {
    for (const [name, job] of Object.entries(template)) {
      const extendsRef = (job as { extends?: string }).extends;
      if (extendsRef) expect(template[extendsRef], `${name} extends ${extendsRef}`).toBeDefined();
    }
  });

  test('the sharded job runs every shard and the shard count matches AUTOMATION_SHARDS', () => {
    const shards: string[] = template['.automation-test-sharded'].parallel.matrix[0].SHARD;
    expect(shards).toEqual(['1/3', '2/3', '3/3']);
    expect(Number(template.variables.AUTOMATION_SHARDS)).toBe(shards.length);
    expect(shards.every((s) => s.endsWith(`/${shards.length}`))).toBe(true);
    expect(template['.automation-test-sharded'].script.join('\n')).toContain('--shard="$SHARD" --reporter=blob');
  });

  test('shards upload their blob reports and the merge job reads them from the same folder', () => {
    expect(template['.automation-test-sharded'].artifacts.paths).toContain('blob-report/');
    expect(template['.automation-merge-reports'].script.join('\n')).toContain('merge-reports --reporter=html ./blob-report');
    expect(template['.automation-merge-reports'].artifacts.reports.junit).toBe('test-results/junit.xml');
  });

  test('the merge job runs even when a shard failed (that is when the report matters), and keeps flake history in the cache', () => {
    expect(template['.automation-merge-reports'].when).toBe('always');
    expect(template['.automation-merge-reports'].cache.paths).toContain('.ci-history/');
    expect(template['.automation-merge-reports'].script.join('\n')).toContain('automation-run-report');
  });

  test('the security job starts non-blocking and runs both gates', () => {
    const job = template['.automation-security'];
    expect(job.allow_failure).toBe(true);
    expect(job.script.join('\n')).toMatch(/automation-scan-secrets[\s\S]*automation-audit-gate/);
  });

  test('no registry address, token or credential is hardcoded: they come from CI variables', () => {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/https?:\/\/(?!github|gitlab\.com|playwright)/); // only documentation links, no internal hosts
    expect(text).toContain('NPM_REGISTRY_URL');
  });
});
