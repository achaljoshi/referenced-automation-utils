import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/** Statements the documentation makes that the repository can check about itself (DOC-01). */
const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test.describe('documentation matches the repository', () => {
  test('ADR 0007 says .secrets/ and .env.*.local are git-ignored - and they are', () => {
    expect(read('docs/adr/0007-secrets.md')).toContain('`.secrets/` are git-ignored');
    const lines = read('.gitignore').split('\n').map((l) => l.trim());
    expect(lines).toContain('.secrets/');
    expect(lines).toContain('.env.*.local');
    const git = spawnSync('git', ['check-ignore', '.secrets/key.bin', '.env.qa.local', '.env.local'], { cwd: root, encoding: 'utf8' });
    if (git.status !== 128) expect(git.stdout.trim().split('\n').sort()).toEqual(['.env.local', '.env.qa.local', '.secrets/key.bin']); // 128: not a git checkout
  });

  test('the governance README names the real ADR range and no longer says the registry is still to come', () => {
    const adrs = fs.readdirSync(path.join(root, 'docs/adr')).map((f) => /^(\d{4})-/.exec(f)?.[1]).filter((n): n is string => !!n && n !== '0000').sort();
    const last = adrs[adrs.length - 1];
    const readme = read('docs/governance/README.md');
    expect(readme).toContain(`ADRs 0001-${last}`);
    expect(readme).not.toMatch(/Moving from `file:` tarballs/);
    expect(readme).toContain('ADR 0010');
  });

  test('every environment variable the mainframe docs and comments mention is actually read by the code', () => {
    const code = sourceFiles('src').map((f) => read(f)).join('\n');
    for (const name of ['TN3270_TIMEOUT_MS', 'S3270_PATH']) {
      expect(code, `${name} is mentioned in src/ ...`).toContain(name);
      expect(code, `... so some code must read it`).toContain(`process.env.${name}`);
    }
  });
});
