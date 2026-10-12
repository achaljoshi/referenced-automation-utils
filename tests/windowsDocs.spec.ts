import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Working inside this repo on Windows. A package's own `bin` commands are not linked into its own node_modules/.bin, so
 * `npx automation-remote ...` fails here ("'automation-remote' is not recognized as an internal or external command")
 * and only works in a project that depends on the package. These tests keep the npm script aliases, the usage texts and
 * the documents in line with that, and keep the PowerShell advice (setting variables, selecting a test file) correct.
 */
const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; bin: Record<string, string> };

function filesUnder(dir: string, pattern: RegExp): string[] {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), pattern) : pattern.test(entry.name) ? [path.join(dir, entry.name)] : []));
}

/** Where the documents and usage texts live. CHANGELOG is history and ci/templates is for projects that depend on this package, so neither is checked. */
const documents = ['README.md', 'CONTRIBUTING.md', 'CROSS_REPO_GUIDE.md', ...filesUnder('docs', /\.md$/), ...filesUnder('src/cli', /\.ts$/), ...filesUnder('scripts', /\.(sh|bat)$/), '.gitlab-ci.yml'];
const readmeDocuments = ['README.md', 'CONTRIBUTING.md', 'CROSS_REPO_GUIDE.md', ...filesUnder('docs', /\.md$/)];

/** A line that says where the `npx <own command>` form works (or that it fails), so it is not a misleading instruction. */
const SAYS_WHERE = /depends? on|dependent project|fails|is not recognized|does not work|do not work/i;

/** Lines that tell the reader to run one of this package's own commands with npx, without saying (on the line or within 8 lines above) that this only works from a dependent project. */
export function misleadingNpx(text: string, bins: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const bad: string[] = [];
  lines.forEach((line, index) => {
    for (const bin of bins) {
      if (!new RegExp(`npx\\s+${bin}\\b`).test(line)) continue;
      const context = lines.slice(Math.max(0, index - 8), index + 1);
      if (!context.some((l) => SAYS_WHERE.test(l))) bad.push(`${index + 1}: ${line.trim()}`);
    }
  });
  return bad;
}

/** `NAME=value npx ...` is bash syntax; PowerShell needs `$env:NAME = "value"`. Flags such a line when no `$env:` is within 8 lines of it. */
export function posixOnlyEnvLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const bad: string[] = [];
  lines.forEach((line, index) => {
    if (!/(^|[\s`])[A-Z][A-Z0-9_]*=\S+ (npx|npm|node) /.test(line)) return;
    if (!lines.slice(Math.max(0, index - 8), index + 9).some((l) => l.includes('$env:'))) bad.push(`${index + 1}: ${line.trim()}`);
  });
  return bad;
}

/** A `playwright test` command whose file argument uses backslashes ("No tests found" on Windows). */
export function backslashTestPaths(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /playwright test[^`\n]*\s[\w.-]+\\[\w.-]/.test(line));
}

const bins = Object.keys(pkg.bin);

test.describe('the package own commands work inside this repo (npm script aliases)', () => {
  test('every bin has an npm script that runs the built file with node', () => {
    expect(bins.length).toBeGreaterThanOrEqual(5);
    for (const [bin, file] of Object.entries(pkg.bin)) {
      const command = `node ${file.replace(/^\.\//, '')}`;
      const aliases = Object.entries(pkg.scripts).filter(([, value]) => value === command).map(([name]) => name);
      expect(aliases, `${bin} needs an npm script that runs "${command}"`).not.toHaveLength(0);
    }
  });

  test('the documented aliases exist, and the older scripts are still there', () => {
    expect(pkg.scripts).toMatchObject({
      remote: 'node dist/cli/remote.js',
      'run-report': 'node dist/cli/runReport.js',
      'scan-secrets': 'node dist/cli/scanSecrets.js',
      'audit-gate': 'node dist/cli/auditGate.js',
      'framework-audit': 'node dist/cli/frameworkAudit.js',
      audit: 'node dist/cli/frameworkAudit.js --run',
      'audit:quick': 'node dist/cli/frameworkAudit.js',
    });
    expect(pkg.scripts.security).toContain('node dist/cli/auditGate.js');
    expect(pkg.scripts.clean).toContain('rimraf --glob');
  });

  test('every alias really starts the tool: usage text, exit code 0, and the "Running it" block that names both forms', () => {
    for (const alias of ['remote', 'run-report', 'scan-secrets', 'audit-gate', 'framework-audit']) {
      const run = spawnSync(`npm run ${alias} --silent -- --help`, { cwd: root, encoding: 'utf8', shell: true });
      expect(run.status, `npm run ${alias} -- --help\n${run.stdout}${run.stderr}`).toBe(0);
      const bin = Object.keys(pkg.bin).find((name) => pkg.bin[name]?.endsWith(`/${(pkg.scripts[alias] as string).split('/').pop()}`)) as string;
      expect(run.stdout, alias).toContain(`${bin} -`);
      expect(run.stdout, alias).toContain('Running it:');
      expect(run.stdout, alias).toContain(`npm run ${alias} -- <arguments>`);
      expect(run.stdout, alias).toContain(`npx ${bin} <arguments>`);
    }
  });
});

test.describe('the documents show the right form of each command', () => {
  test('no document or usage text shows `npx <own command>` without saying it works only from a project that depends on this package', () => {
    expect(documents.length).toBeGreaterThan(20);
    const found = documents.flatMap((file) => misleadingNpx(read(file), bins).map((line) => `${file}:${line}`));
    expect(found).toEqual([]);
    // the scan does see the npx forms that ARE there (otherwise it would pass on nothing)
    const mentions = documents.filter((file) => bins.some((bin) => read(file).includes(`npx ${bin}`)));
    expect(mentions).toEqual(expect.arrayContaining(['README.md', 'CONTRIBUTING.md', 'docs/REMOTE_DESKTOP.md', 'docs/governance/AUDIT.md']));
  });

  test('no document sets a variable the bash way without also showing PowerShell', () => {
    expect(readmeDocuments.flatMap((file) => posixOnlyEnvLines(read(file)).map((line) => `${file}:${line}`))).toEqual([]);
  });

  test('no document selects a Playwright test file with a backslash path', () => {
    expect(readmeDocuments.flatMap((file) => backslashTestPaths(read(file)).map((line) => `${file}: ${line.trim()}`))).toEqual([]);
  });

  test('the README has a "Windows first run" section with the install, the build, the test run and the common first errors', () => {
    const readme = read('README.md');
    const start = readme.indexOf('\n## Windows first run\n');
    expect(start, 'a "## Windows first run" heading').toBeGreaterThan(-1);
    const rest = readme.slice(start + 1);
    const section = rest.slice(0, rest.indexOf('\n## ', 3));
    for (const needle of ['.\\scripts\\setup.bat', 'npm run build', 'npm test', "'tsc' is not recognized", "Cannot find module", 'No tests found', 'Illegal characters in path', '*.tgz', 'rimraf --glob', '$env:', 'Remove-Item Env:', 'npm run remote -- doctor', 'forward slashes'])
      expect(section, `the section should mention ${needle}`).toContain(needle);
    expect(section).not.toMatch(/JAVA_HOME|JDK/);
    expect(readme).toContain('(#windows-first-run)');
  });

  test('the VS Code debug configurations work on Windows (no shell-script launcher, no backslash test path)', () => {
    const launch = read('.vscode/launch.json');
    expect(launch).not.toContain('node_modules/.bin/playwright'); // a shell script on Windows, which node cannot run
    expect(launch).not.toContain('${relativeFile}'); // backslashes on Windows: "No tests found"
    expect(launch).toContain('node_modules/@playwright/test/cli.js');
    expect(fs.existsSync(path.join(root, 'node_modules/@playwright/test/cli.js'))).toBe(true);
  });

  test('the scripts that are documented for Windows exist', () => {
    for (const script of ['setup', 'create-package', 'publish-package', 'audit-family']) expect(fs.existsSync(path.join(root, 'scripts', `${script}.bat`)), `${script}.bat`).toBe(true);
    expect(pkg.scripts.clean).toBe('rimraf --glob dist "*.tgz"');
  });

  test.describe('negative controls: the checks above do fail on a bad document', () => {
    test('npx of an own command is flagged unless the text says where it works', () => {
      const bad = 'Run it:\n\n```bash\nnpx automation-remote doctor\n```\n';
      const good = 'From a project that depends on this package:\n\n```bash\nnpx automation-remote doctor\n```\n';
      const failing = "Inside this repo `npx automation-remote doctor` fails with 'is not recognized'.";
      const farAway = `From a project that depends on this package.\n${'filler\n'.repeat(9)}npx automation-remote doctor\n`;
      expect(misleadingNpx(bad, bins)).toEqual(['4: npx automation-remote doctor']);
      expect(misleadingNpx(good, bins)).toEqual([]);
      expect(misleadingNpx(failing, bins)).toEqual([]);
      expect(misleadingNpx(farAway, bins)).toHaveLength(1);
      expect(misleadingNpx('npx playwright test', bins)).toEqual([]);
    });

    test('a bash-only variable assignment is flagged unless PowerShell is shown nearby', () => {
      expect(posixOnlyEnvLines('```bash\nENV=stage npx playwright test\n```')).toEqual(['2: ENV=stage npx playwright test']);
      expect(posixOnlyEnvLines('```bash\nENV=stage npx playwright test\n```\n```powershell\n$env:ENV = "stage"; npx playwright test\n```')).toEqual([]);
      expect(posixOnlyEnvLines('Run `LOG_LEVEL=debug npx x` or `$env:LOG_LEVEL = "debug"; npx x`.')).toEqual([]);
      expect(posixOnlyEnvLines('npx playwright test')).toEqual([]);
    });

    test('a backslash test path is flagged, a forward-slash one is not', () => {
      expect(backslashTestPaths('npx playwright test tests\\env.spec.ts')).toHaveLength(1);
      expect(backslashTestPaths('npx playwright test tests/env.spec.ts')).toHaveLength(0);
      expect(backslashTestPaths('Backslash paths (`tests\\env.spec.ts`) are the usual cause')).toHaveLength(0);
    });
  });
});
