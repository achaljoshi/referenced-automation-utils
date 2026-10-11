import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { describeSession } from '../src/cli/remote';
import { StandInAgent } from './support/standInAgent';
import { cleanTmpDirs, startHttpServer, tmpDir } from './support/remoteFixtures';

test.afterAll(cleanTmpDirs);

const cli = path.resolve(__dirname, '..', 'dist', 'cli', 'remote.js');
const SECRET = 'Cli-Secret-never-print';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the real CLI as a child process, asynchronously (the stand-in agent lives in THIS process and must keep running). */
function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', LOG_TO_FILE: 'false', NO_COLOR: '1', ENV: 'cli-test', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const baseEnv = (share: string, extra: Record<string, string> = {}): Record<string, string> => ({
  REMOTE_ENABLED: 'true',
  REMOTE_RDP_HOST: 'rdp-host.test',
  REMOTE_AGENT_START: 'manual',
  REMOTE_SHARE_DIR: share,
  REMOTE_RDP_USER: 'svc',
  REMOTE_RDP_PASSWORD: SECRET,
  REMOTE_POLL_MS: '20',
  REMOTE_HEARTBEAT_MS: '100',
  REMOTE_HEARTBEAT_STALE_MS: '1000',
  REMOTE_CONNECT_TIMEOUT_MS: '3000',
  REMOTE_REQUEST_TIMEOUT_MS: '5000',
  ...extra,
});

test.describe('describeSession', () => {
  test('interactive only on Windows with a session name that is not Services', () => {
    expect(describeSession({ SESSIONNAME: 'Console' }, 'win32')).toMatchObject({ interactive: true, detail: 'SESSIONNAME=Console' });
    expect(describeSession({ SESSIONNAME: 'RDP-Tcp#3' }, 'win32').interactive).toBe(true);
    expect(describeSession({ SESSIONNAME: 'Services' }, 'win32')).toMatchObject({ interactive: false, detail: 'SESSIONNAME is "Services"' });
    expect(describeSession({ SESSIONNAME: 'services' }, 'win32').interactive).toBe(false);
    expect(describeSession({}, 'win32')).toMatchObject({ interactive: false, detail: 'SESSIONNAME is not set' });
    expect(describeSession({ SESSIONNAME: 'Console' }, 'linux')).toMatchObject({ interactive: false });
    expect(describeSession({ SESSIONNAME: 'Console' }, 'linux').detail).toContain('linux, not Windows');
  });
});

test.describe('automation-remote doctor', () => {
  test('reports the configuration with secrets masked, warns (does not fail) about the session, and exits 0 for a startup/manual setup', async () => {
    const share = tmpDir();
    const result = await runCli(['doctor'], baseEnv(share, { REMOTE_DB_CONNECTION_STRING: `Server=s;Password=${SECRET}` }), tmpDir());
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PASS {2}configuration - .*rdp-host\.test/m);
    expect(result.stdout).toContain('"password":"********"');
    expect(result.stdout).toContain('"dbConnectionString":"********"');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout).toMatch(/^WARN {2}interactive Windows session - /m);
    expect(result.stdout).toContain('hint: start the tests from a logged-in desktop session');
    expect(result.stdout).toMatch(/^PASS {2}RDP tools - not needed with REMOTE_AGENT_START=manual/m);
    expect(result.stdout).toMatch(/^PASS {2}agent files - /m);
    expect(result.stdout).toMatch(/^PASS {2}mailbox folder - /m);
    expect(fs.existsSync(path.join(share, 'requests'))).toBe(true);
  });

  test('alternate-shell on a machine that is not Windows FAILS the RDP tools check (exit 1) - and exec in the allow list is a warning', async () => {
    test.skip(process.platform === 'win32', 'this case needs a machine that is not Windows');
    const result = await runCli(['doctor'], baseEnv(tmpDir(), { REMOTE_AGENT_START: 'alternate-shell', REMOTE_ALLOW: 'http,exec' }), tmpDir());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL {2}RDP tools - this machine is \w+, not Windows/m);
    expect(result.stdout).toMatch(/^WARN {2}exec allowed/m);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  test('a bad setting fails the configuration check (exit 1) without echoing the secret', async () => {
    const result = await runCli(['doctor'], baseEnv(tmpDir(), { REMOTE_RDP_PORT: 'abc' }), tmpDir());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL {2}configuration - .*REMOTE_RDP_PORT.*not a valid integer/m);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  test('without REMOTE_ENABLED it says how to switch the feature on (exit 1)', async () => {
    const result = await runCli(['doctor'], {}, tmpDir());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL {2}configuration - .*REMOTE_ENABLED is not true/m);
  });
});

test.describe('automation-remote check', () => {
  test('against the stand-in agent: PASS for every stage, including http from the host, SELECT 1 and hostname', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    const server = await startHttpServer();
    try {
      const result = await runCli(['check', '--url', `${server.url}/echo`, '--db', '--exec'], baseEnv(share, { REMOTE_ALLOW: 'http,db,sap,exec', REMOTE_DB_PROVIDER: 'sqlite-stand-in', REMOTE_DB_CONNECTION_STRING: ':memory:' }), tmpDir());
      expect(result.stdout, result.stderr).toMatch(/^PASS {2}configuration/m);
      for (const stage of ['mailbox folder', 'agent connection', 'ping', 'interactive session', `http GET ${server.url}/echo`, 'db SELECT 1', 'exec hostname'])
        expect(result.stdout).toContain(`PASS  ${stage}`);
      expect(result.stdout).not.toMatch(/^FAIL/m);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('STAND-IN-HOST');
      expect(agent.processed).toEqual(['ping', 'http', 'db.query', 'exec']);
      expect(agent.isRunning).toBe(true); // manual mode: check does not stop the user's agent
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    } finally {
      await server.close();
      await agent.stop();
    }
  });

  test('a failing stage is FAIL with its hint and the exit code is 1', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    try {
      const result = await runCli(['check', '--db', '--exec'], baseEnv(share), tmpDir());
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('PASS  ping');
      expect(result.stdout).toMatch(/^FAIL {2}db SELECT 1 - .*REMOTE_DB_PROVIDER/m);
      expect(result.stdout).toContain('hint: set REMOTE_DB_PROVIDER and REMOTE_DB_CONNECTION_STRING');
      expect(result.stdout).toMatch(/^FAIL {2}exec hostname - .*must be listed explicitly/m);
      expect(result.stdout).toContain('hint: add "exec" to REMOTE_ALLOW');
    } finally {
      await agent.stop();
    }
  });

  test('no agent: the connection stage fails with the checklist (exit 1)', async () => {
    const result = await runCli(['check'], baseEnv(tmpDir(), { REMOTE_CONNECT_TIMEOUT_MS: '300' }), tmpDir());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL {2}agent connection - \[remote\] connect failed: no agent heartbeat appeared within 300ms/m);
    expect(result.stdout).toContain('Likely causes');
  });

  test('an unknown option is a usage error (exit 2), not silently ignored', async () => {
    const result = await runCli(['check', '--urll', 'x'], baseEnv(tmpDir()), tmpDir());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option --urll');
  });
});

test.describe('automation-remote open / close / agent-dir / setup-help', () => {
  test('agent-dir prints <share>/agent and creates it with the agent files', async () => {
    const share = tmpDir();
    const result = await runCli(['agent-dir'], baseEnv(share), tmpDir());
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(share, 'agent'));
    expect(fs.readdirSync(path.join(share, 'agent')).sort()).toEqual(['remote-agent.ps1', 'start.cmd']);
  });

  test('setup-help prints the steps for the configured mode, with the real drive letter and folder', async () => {
    const share = tmpDir();
    const manual = await runCli(['setup-help'], baseEnv(share, { REMOTE_DRIVE_LETTER: 'Q' }), tmpDir());
    expect(manual.code).toBe(0);
    expect(manual.stdout).toContain('REMOTE_AGENT_START=manual');
    expect(manual.stdout).toContain(`subst Q: "${share}"`);
    expect(manual.stdout).toContain('\\\\tsclient\\Q\\agent\\start.cmd');
    const startup = await runCli(['setup-help'], baseEnv(share, { REMOTE_AGENT_START: 'startup' }), tmpDir());
    expect(startup.stdout).toContain('shell:startup');
    expect(startup.stdout).toContain('-File \\\\tsclient\\R\\agent\\remote-agent.ps1');
    const alt = await runCli(['setup-help'], baseEnv(share, { REMOTE_AGENT_START: 'alternate-shell' }), tmpDir());
    expect(alt.stdout).toContain('alternate-shell needs no setup');
    expect(alt.stdout).toContain('shell:startup');
    expect(alt.stdout).toContain('start.cmd');
  });

  test('open connects and leaves the agent running; close asks it to shut down', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    try {
      const opened = await runCli(['open'], baseEnv(share), tmpDir());
      expect(opened.code, opened.stderr).toBe(0);
      expect(opened.stdout).toContain('agent is up');
      expect(agent.isRunning).toBe(true);
      expect(fs.readdirSync(path.join(share, 'agent', 'clients'))).toEqual([]); // the CLI process is gone
      const closed = await runCli(['close'], baseEnv(share), tmpDir());
      expect(closed.code, closed.stderr).toBe(0);
      expect(closed.stdout).toContain('shutdown requested');
      await expect.poll(() => agent.isRunning).toBe(false);
      expect(agent.processed).toContain('shutdown');
      const again = await runCli(['close'], baseEnv(share), tmpDir());
      expect(again.stdout).toContain('no agent was running');
    } finally {
      await agent.stop();
    }
  });

  test('no command prints the usage and exits 2; an unknown command exits 2; --help exits 0', async () => {
    const none = await runCli([], {}, tmpDir());
    expect(none.code).toBe(2);
    expect(none.stdout).toContain('automation-remote doctor');
    const unknown = await runCli(['frobnicate'], baseEnv(tmpDir()), tmpDir());
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "frobnicate"');
    const help = await runCli(['--help'], {}, tmpDir());
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('NOT VERIFIED on a real Windows host');
  });
});
