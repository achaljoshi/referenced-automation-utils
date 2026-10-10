import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The lint rules that guard the most damaging test bugs (CI-07, ADR 0005) are checked by running ESLint with the
 * repository's own configuration on a file that breaks each of them - so a rule that is removed, mistyped or
 * switched off fails here instead of silently going quiet.
 */
const root = path.resolve(__dirname, '..');
const eslint = path.join(root, 'node_modules/eslint/bin/eslint.js'); // not require.resolve: eslint's package exports hide bin/

function lint(source: string): Array<{ ruleId: string | null; message: string; line: number }> {
  // type-aware rules need the file to be part of the TypeScript project, so it is written under tests/ for the run
  const file = path.join(__dirname, `zz-lint-fixture-${process.pid}-${Date.now()}.ts`);
  fs.writeFileSync(file, source);
  try {
    const run = spawnSync(process.execPath, [eslint, file, '--format', 'json', '--max-warnings', '0'], { cwd: root, encoding: 'utf8' });
    const parsed = JSON.parse(run.stdout) as Array<{ messages: Array<{ ruleId: string | null; message: string; line: number }> }>;
    return parsed[0]?.messages ?? [];
  } finally {
    fs.rmSync(file, { force: true });
  }
}

test.describe('lint guards', () => {
  test.describe.configure({ timeout: 120_000 }); // a type-aware ESLint start-up is slow on a cold machine

  test('a floating promise, a promise passed where nothing awaits it, and the banned waits are all errors', () => {
    const messages = lint(
      [
        "import type { Page } from '@playwright/test';",
        'async function check(): Promise<void> {}',
        'export function broken(page: Page): void {',
        '  check(); // line 4: floating',
        '  [1, 2].forEach(async () => { await check(); }); // line 5: misused',
        '  void page.waitForTimeout(500); // line 6: hard wait',
        "  void page.waitForLoadState('networkidle'); // line 7: networkidle",
        "  void page.goto('/', { waitUntil: 'networkidle' }); // line 8: networkidle",
        '}',
      ].join('\n'),
    );
    const byLine = (rule: string) => messages.filter((m) => m.ruleId === rule).map((m) => m.line);
    expect(byLine('@typescript-eslint/no-floating-promises')).toEqual([4]);
    expect(byLine('@typescript-eslint/no-misused-promises')).toEqual([5]);
    expect(byLine('no-restricted-syntax')).toEqual([6, 7, 8]);
    expect(messages.find((m) => m.line === 6)?.message).toContain('ADR 0005');
  });

  test('awaited, voided and caught promises are fine', () => {
    const messages = lint(
      [
        'async function check(): Promise<number> { return 1; }',
        'export async function fine(): Promise<void> {',
        '  await check();',
        '  void check();',
        '  check().catch(() => undefined);',
        '  await Promise.all([check(), check()]);',
        '}',
      ].join('\n'),
    );
    expect(messages).toEqual([]);
  });

  test('npm run lint treats warnings as failures', () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.lint).toContain('--max-warnings 0');
  });
});
