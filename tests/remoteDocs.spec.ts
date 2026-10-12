import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/** The remote-desktop documentation says things the repository can check about itself. */
const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const unique = (keys: string[]) => [...new Set(keys)].sort();
/** The settings the code reads: the names it passes to the ConfigReader getters. */
const codeKeys = unique([...read('src/remote/config.ts').matchAll(/env\.get\w*\(\s*'(REMOTE_[A-Z0-9_]+)'/g)].map((m) => m[1] as string));
/** The settings the docs list: names in the first cell of a settings-table row, and the `# KEY=` lines of .env.example. */
const docKeys = unique([...read('docs/REMOTE_DESKTOP.md').matchAll(/^\|([^|]*)\|/gm)].flatMap((m) => [...(m[1] as string).matchAll(/`(REMOTE_[A-Z0-9_]+)`/g)].map((k) => k[1] as string)));
const exampleKeys = unique([...read('.env.example').matchAll(/^#?\s*(REMOTE_[A-Z0-9_]+)=/gm)].map((m) => m[1] as string));

test.describe('remote desktop documentation matches the code', () => {
  test('every REMOTE_* key the config reads is documented in docs/REMOTE_DESKTOP.md (table row) and in .env.example', () => {
    expect(codeKeys).toHaveLength(21);
    const docs = read('docs/REMOTE_DESKTOP.md');
    const example = read('.env.example');
    for (const key of codeKeys) {
      expect(docs, `${key} in the settings table`).toMatch(new RegExp(`^\\|[^|]*\`${key}\``, 'm'));
      expect(example, `${key} in .env.example`).toContain(key);
    }
  });

  test('the docs and .env.example name no REMOTE_* key the code does not read', () => {
    expect(docKeys).toEqual(codeKeys);
    expect(exampleKeys).toEqual(codeKeys);
  });

  test('the secret settings are marked as secrets in the docs and in .env.example', () => {
    const docs = read('docs/REMOTE_DESKTOP.md');
    for (const key of ['REMOTE_RDP_PASSWORD', 'REMOTE_DB_CONNECTION_STRING']) {
      expect(docs).toMatch(new RegExp(`\\| \`${key}\` \\|[^\\n]*\\*\\*Secret\\.\\*\\*`));
      expect(read('.env.example')).toMatch(new RegExp(`\\| Secret: YES[^\\n]*\\n# Example[^\\n]*\\n# ${key}=`));
    }
  });

  test('the mailbox is git-ignored and the package ships the agent and the CLI', () => {
    expect(read('.gitignore').split('\n').map((l) => l.trim())).toContain('.remote-mailbox/');
    const pkg = JSON.parse(read('package.json')) as { files: string[]; bin: Record<string, string> };
    expect(pkg.files).toContain('agent');
    expect(pkg.bin['automation-remote']).toBe('./dist/cli/remote.js');
    expect(fs.existsSync(path.join(root, 'agent', 'remote-agent.ps1'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'agent', 'start.cmd'))).toBe(true);
    expect(read('src/cli/remote.ts').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  test('ADR 0012 exists and is in the index; the changelog and README point at the feature; the docs are honest about verification', () => {
    expect(fs.existsSync(path.join(root, 'docs/adr/0012-remote-host-over-rdp-drive-mailbox.md'))).toBe(true);
    expect(read('docs/adr/README.md')).toContain('[0012](0012-remote-host-over-rdp-drive-mailbox.md)');
    expect(read('CHANGELOG.md')).toMatch(/\*\*`remote`: run steps on a remote desktop host/);
    expect(read('CHANGELOG.md')).toMatch(/NOT VERIFIED on a real Windows host/);
    expect(read('README.md')).toContain('(docs/REMOTE_DESKTOP.md)');
    for (const file of ['docs/REMOTE_DESKTOP.md', 'docs/adr/0012-remote-host-over-rdp-drive-mailbox.md', 'src/remote/rdp.ts', 'agent/remote-agent.ps1'])
      expect(read(file), file).toMatch(/NOT VERIFIED/);
    expect(read('docs/REMOTE_DESKTOP.md')).toContain('## Verified / NOT verified');
  });

  test('the test machine is called the test machine (for example an AWS WorkSpace); "laptop" only appears as the user\'s own client in the three-hop diagram and the nested-RDP note', () => {
    const codeFiles = [...fs.readdirSync(path.join(root, 'src/remote')).map((f) => `src/remote/${f}`), 'src/cli/remote.ts', 'agent/remote-agent.ps1', 'agent/start.cmd', 'docs/adr/0012-remote-host-over-rdp-drive-mailbox.md'];
    for (const file of codeFiles) expect(read(file), file).not.toMatch(/\blaptop\b/i);
    const docs = read('docs/REMOTE_DESKTOP.md');
    for (const match of docs.matchAll(/\blaptop\b/gi)) expect(docs.slice(Math.max(0, match.index - 5), match.index).toLowerCase(), 'every "laptop" in the docs is "your laptop"').toBe('your ');
    expect(docs).toContain('(for example an AWS WorkSpace)');
  });

  test('the docs contain the two Mermaid diagrams and the requirements section for the interactive session and the nested RDP', () => {
    const docs = read('docs/REMOTE_DESKTOP.md');
    expect([...docs.matchAll(/```mermaid\nflowchart/g)]).toHaveLength(2);
    expect(docs).toContain('## Requirements on the test machine');
    expect(docs).toMatch(/interactive, logged-in desktop session/);
    expect(docs).toMatch(/Windows service, a scheduled task that runs without a desktop, or a Linux WorkSpace/);
    expect(docs).toMatch(/nested/);
    expect(docs).toMatch(/lives on the \*\*WorkSpace's disk\*\*/);
  });
});
