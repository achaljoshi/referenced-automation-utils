import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { RemoteConfig } from '../src/remote/config';
import { RemoteError } from '../src/remote/errors';
import { RdpSession, agentCommandLine, buildRdpFile, checkRdpPrerequisites, maskCommandLine, parseSubstList } from '../src/remote/rdp';
import { FakeRunner, captureStdout, cleanTmpDirs, testConfig, tmpDir } from './support/remoteFixtures';

test.afterAll(cleanTmpDirs);

const PASSWORD = 'Hunter2!-rdp-secret';

function altShellConfig(overrides: Partial<Parameters<typeof RemoteConfig.create>[0]> = {}): RemoteConfig {
  return testConfig(tmpDir(), { agentStart: 'alternate-shell', user: 'svc-tests', password: PASSWORD, driveLetter: 'R', ...overrides });
}

const session = (config: RemoteConfig, runner: FakeRunner) => new RdpSession(config, { runner, tempDir: tmpDir() });

test.describe('the .rdp file', () => {
  test('redirects ONLY the subst drive and turns every other redirection off', () => {
    const text = buildRdpFile(altShellConfig({ host: 'rdp-host.test', port: 3390, width: 1024, height: 768 }));
    const lines = text.split('\r\n');
    expect(lines).toEqual(expect.arrayContaining([
      'full address:s:rdp-host.test:3390',
      'username:s:svc-tests',
      'prompt for credentials:i:0',
      'enablecredsspsupport:i:1',
      'authentication level:i:2',
      'drivestoredirect:s:R:\\',
      'redirectclipboard:i:0',
      'redirectprinters:i:0',
      'redirectcomports:i:0',
      'redirectsmartcards:i:0',
      'audiomode:i:2',
      'screen mode id:i:1',
      'desktopwidth:i:1024',
      'desktopheight:i:768',
      `alternate shell:s:powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File \\\\tsclient\\R\\agent\\remote-agent.ps1`,
      'shell working directory:s:C:\\',
    ]));
    expect(lines.filter((l) => l.startsWith('drivestoredirect'))).toEqual(['drivestoredirect:s:R:\\']); // one drive, not "*" and not C:
    expect(text).not.toMatch(/drivestoredirect:s:(\*|C:|DynamicDrives)/i);
    expect(text).not.toMatch(/redirect\w+:i:1/);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  test('never contains the password', () => {
    expect(buildRdpFile(altShellConfig())).not.toContain(PASSWORD);
    expect(buildRdpFile(altShellConfig())).not.toMatch(/password/i);
  });

  test('a domain gets its own line; without one there is none', () => {
    expect(buildRdpFile(altShellConfig({ domain: 'CORP' })).split('\r\n')).toContain('domain:s:CORP');
    expect(buildRdpFile(altShellConfig())).not.toContain('domain:s:');
  });

  test('"alternate shell" and "shell working directory" only for the alternate-shell start mode', () => {
    for (const agentStart of ['startup', 'manual'] as const) {
      const text = buildRdpFile(altShellConfig({ agentStart }));
      expect(text).not.toContain('alternate shell');
      expect(text).not.toContain('shell working directory');
      expect(text).toContain('drivestoredirect:s:R:\\');
    }
  });

  test('the agent command line uses the configured drive letter', () => {
    expect(agentCommandLine('Q')).toBe('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File \\\\tsclient\\Q\\agent\\remote-agent.ps1');
    expect(buildRdpFile(altShellConfig({ driveLetter: 'Q' }))).toContain('\\\\tsclient\\Q\\agent\\remote-agent.ps1');
  });
});

test.describe('RdpSession.open', () => {
  test('runs exactly: subst (list, map), cmdkey add, mstsc <file>, the wait, cmdkey delete', async () => {
    const config = altShellConfig();
    const runner = new FakeRunner();
    let waited = false;
    let commandsWhenWaiting: string[] = [];
    const rdp = session(config, runner);
    await rdp.open(async () => {
      waited = true;
      commandsWhenWaiting = [...runner.commands];
    });
    expect(waited).toBe(true);
    const rdpFile = runner.calls.find((c) => c.kind === 'launch')?.args[0] as string;
    expect(runner.commands).toEqual([
      'subst',
      `subst R: ${config.shareDir}`,
      `cmdkey /generic:TERMSRV/rdp-host.test /user:svc-tests /pass:${PASSWORD}`,
      `launch mstsc ${rdpFile}`,
      'cmdkey /delete:TERMSRV/rdp-host.test',
    ]);
    expect(commandsWhenWaiting).toHaveLength(4); // the credential is still stored while mstsc connects, and gone right after
    expect(runner.calls.filter((c) => c.kind === 'exists').map((c) => c.command)).toEqual(['mstsc', 'cmdkey', 'subst']);
    expect(path.extname(rdpFile)).toBe('.rdp');
    const written = fs.readFileSync(rdpFile, 'utf8');
    expect(written).toBe(buildRdpFile(config));
    expect(written).not.toContain(PASSWORD);
    await rdp.close({ graceMs: 0 });
  });

  test('a domain makes the stored credential DOMAIN\\user', async () => {
    const runner = new FakeRunner();
    await session(altShellConfig({ domain: 'CORP' }), runner).open(async () => undefined);
    expect(runner.commands.find((c) => c.startsWith('cmdkey /generic'))).toBe(`cmdkey /generic:TERMSRV/rdp-host.test /user:CORP\\svc-tests /pass:${PASSWORD}`);
  });

  test('cmdkey /delete runs even when mstsc can not be launched', async () => {
    const runner = new FakeRunner();
    runner.launchError = new Error(`spawn mstsc ENOENT (${PASSWORD})`);
    const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
    expect(error).toBeInstanceOf(RemoteError);
    expect(error.code).toBe('RDP_LAUNCH_FAILED');
    expect(error.message).toContain('could not start mstsc');
    expect(error.message).not.toContain(PASSWORD);
    expect(runner.commands.filter((c) => c.startsWith('cmdkey /delete'))).toEqual(['cmdkey /delete:TERMSRV/rdp-host.test']);
    expect(runner.commands.indexOf('cmdkey /delete:TERMSRV/rdp-host.test')).toBeGreaterThan(runner.commands.findIndex((c) => c.startsWith('cmdkey /generic')));
    expect(runner.commands).toContain('subst R: /D'); // what open() set up is torn down again
  });

  test('cmdkey /delete runs when the wait for the agent times out, once, and mstsc is closed', async () => {
    const runner = new FakeRunner();
    const failure = new RemoteError('AGENT_NOT_STARTED', 'no heartbeat');
    const error = await session(altShellConfig(), runner).open(async () => Promise.reject(failure)).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(runner.commands.filter((c) => c.startsWith('cmdkey /delete'))).toHaveLength(1);
    expect(runner.launched[0]?.killed).toBe(true);
  });

  test('cmdkey /delete runs when cmdkey /generic itself fails, and the password is scrubbed from the message', async () => {
    const runner = new FakeRunner();
    runner.onRun = (command, args) => (command === 'cmdkey' && args[0]?.startsWith('/generic') ? { status: 1, stdout: '', stderr: `bad credential ${PASSWORD}` } : undefined);
    const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
    expect(error.code).toBe('RDP_LAUNCH_FAILED');
    expect(error.message).toContain('cmdkey could not store the login');
    expect(error.message).not.toContain(PASSWORD);
    expect(runner.commands.some((c) => c.startsWith('cmdkey /delete'))).toBe(true);
    expect(runner.calls.some((c) => c.kind === 'launch')).toBe(false);
  });

  test('a failing cmdkey /delete is a warning, not a failure - and the message never carries the password', async () => {
    const runner = new FakeRunner();
    runner.onRun = (command, args) => (command === 'cmdkey' && args[0]?.startsWith('/delete') ? { status: 1, stdout: '', stderr: `nope ${PASSWORD}` } : undefined);
    const { error, output } = await captureStdout(() => session(altShellConfig(), runner).open(async () => undefined));
    expect(error).toBeUndefined();
    expect(output).toContain('could not delete the stored login');
    expect(output).not.toContain(PASSWORD);
  });

  test('close(): ends our mstsc, removes the drive we created, and leaves no credential behind', async () => {
    const runner = new FakeRunner();
    const rdp = session(altShellConfig(), runner);
    await rdp.open(async () => undefined);
    const rdpFile = rdp.rdpFilePath as string;
    expect(fs.existsSync(rdpFile)).toBe(true);
    await rdp.close({ graceMs: 0 });
    expect(runner.launched[0]?.killed).toBe(true);
    expect(runner.commands.at(-1)).toBe('subst R: /D');
    expect(fs.existsSync(rdpFile)).toBe(false);
    expect(runner.commands.filter((c) => c.startsWith('cmdkey /delete'))).toHaveLength(1); // not repeated
    await rdp.close(); // idempotent
    expect(runner.commands.filter((c) => c === 'subst R: /D')).toHaveLength(1);
  });

  test('close() waits for mstsc to end by itself (the agent shutdown logs the session off) before killing it', async () => {
    const runner = new FakeRunner();
    const rdp = session(altShellConfig(), runner);
    await rdp.open(async () => undefined);
    setTimeout(() => runner.launched[0]?.end(0), 150);
    await rdp.close({ graceMs: 3000 });
    expect(runner.launched[0]?.killed).toBe(false);
  });

  test('detach() leaves mstsc and the drive alone', async () => {
    const runner = new FakeRunner();
    const rdp = session(altShellConfig(), runner);
    await rdp.open(async () => undefined);
    rdp.detach();
    await rdp.close({ graceMs: 0 });
    expect(runner.launched[0]?.unrefd).toBe(true);
    expect(runner.launched[0]?.killed).toBe(false);
    expect(runner.commands).not.toContain('subst R: /D');
  });

  test('a drive letter that already maps to the SAME folder is reused, and not removed again on close', async () => {
    const config = altShellConfig();
    const runner = new FakeRunner();
    runner.substList = `R:\\: => ${config.shareDir}\r\n`;
    const rdp = session(config, runner);
    await rdp.open(async () => undefined);
    await rdp.close({ graceMs: 0 });
    expect(runner.commands.filter((c) => c.startsWith('subst R:'))).toEqual([]);
    expect(runner.commands).not.toContain('subst R: /D');
  });

  test('a drive letter that maps to a DIFFERENT folder is refused before anything else happens', async () => {
    const runner = new FakeRunner();
    runner.substList = 'R:\\: => D:\\somewhere\\else\r\n';
    const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
    expect(error.code).toBe('RDP_LAUNCH_FAILED');
    expect(error.message).toMatch(/drive R: is already mapped \(subst\) to D:\\somewhere\\else/);
    expect(error.message).toContain('REMOTE_DRIVE_LETTER');
    expect(runner.commands).toEqual(['subst']);
  });

  test('a letter that is a real drive is refused (the mailbox must never shadow one)', async () => {
    const runner = new FakeRunner();
    runner.realDrives.add('R');
    const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
    expect(error.message).toMatch(/drive R: is a real drive/);
    expect(runner.commands).toEqual(['subst']);
  });

  test('a failing subst is reported with its message', async () => {
    const runner = new FakeRunner();
    runner.onRun = (command, args) => (command === 'subst' && args.length === 2 ? { status: 1, stdout: '', stderr: 'Invalid parameter' } : undefined);
    const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
    expect(error.code).toBe('RDP_LAUNCH_FAILED');
    expect(error.message).toContain('Invalid parameter');
    expect(runner.commands.some((c) => c.startsWith('cmdkey'))).toBe(false); // nothing stored, nothing to delete
  });

  test('refuses on a platform that is not win32, naming what is missing - and runs nothing', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const runner = new FakeRunner(platform);
      const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
      expect(error).toBeInstanceOf(RemoteError);
      expect(error.code).toBe('UNSUPPORTED_PLATFORM');
      expect(error.message).toContain('needs Windows with mstsc, cmdkey, subst');
      expect(error.message).toContain(platform);
      expect(error.message).toContain('startup|manual');
      expect(runner.calls).toEqual([]);
    }
  });

  test('refuses on Windows when a tool is missing, naming the tools', async () => {
    const runner = new FakeRunner();
    runner.missingTools.add('mstsc').add('subst');
    const error = (await session(altShellConfig(), runner).open(async () => undefined).catch((e: unknown) => e)) as RemoteError;
    expect(error.code).toBe('UNSUPPORTED_PLATFORM');
    expect(error.message).toContain('not found on the PATH: mstsc, subst');
    expect(runner.commands).toEqual([]);
  });

  test('the password is in the cmdkey call and nowhere else: not in logs, errors or the .rdp file', async () => {
    const runner = new FakeRunner();
    const { output, error } = await captureStdout(async () => {
      const rdp = session(altShellConfig(), runner);
      await rdp.open(async () => undefined);
      await rdp.close({ graceMs: 0 });
    });
    expect(error).toBeUndefined();
    expect(output).toContain('mstsc started');
    expect(output).not.toContain(PASSWORD);
    const containing = runner.calls.filter((c) => [c.command, ...c.args].some((a) => a.includes(PASSWORD)));
    expect(containing.map((c) => `${c.command} ${c.args[0]}`)).toEqual(['cmdkey /generic:TERMSRV/rdp-host.test']);
  });
});

test.describe('helpers', () => {
  test('maskCommandLine hides /pass:', () => {
    expect(maskCommandLine(['/generic:TERMSRV/h', '/user:u', `/pass:${PASSWORD}`])).toEqual(['/generic:TERMSRV/h', '/user:u', '/pass:********']);
    expect(maskCommandLine(['/PASS:x'])).toEqual(['/pass:********']);
  });

  test('parseSubstList reads the mapping of one letter', () => {
    const out = 'R:\\: => C:\\Users\\me\\mail box\r\nS:\\: => UNC\\server\\share\r\n';
    expect(parseSubstList(out, 'R')).toBe('C:\\Users\\me\\mail box');
    expect(parseSubstList(out, 's')).toBe('UNC\\server\\share');
    expect(parseSubstList(out, 'T')).toBeUndefined();
    expect(parseSubstList('', 'R')).toBeUndefined();
  });

  test('checkRdpPrerequisites: not Windows -> nothing found; Windows -> the tools are looked up', () => {
    expect(checkRdpPrerequisites(new FakeRunner('darwin'))).toMatchObject({ windows: false, tools: [{ name: 'mstsc', found: false }, { name: 'cmdkey', found: false }, { name: 'subst', found: false }] });
    const runner = new FakeRunner();
    runner.missingTools.add('cmdkey');
    expect(checkRdpPrerequisites(runner).tools).toEqual([{ name: 'mstsc', found: true }, { name: 'cmdkey', found: false }, { name: 'subst', found: true }]);
  });

  test('releaseDrive removes the mapping only when it points at our mailbox folder', () => {
    const config = altShellConfig();
    const ours = new FakeRunner();
    ours.substList = `R:\\: => ${config.shareDir}\r\n`;
    expect(RdpSession.releaseDrive(config, ours)).toBe(true);
    expect(ours.commands).toContain('subst R: /D');
    const other = new FakeRunner();
    other.substList = 'R:\\: => D:\\else\r\n';
    expect(RdpSession.releaseDrive(config, other)).toBe(false);
    expect(other.commands).not.toContain('subst R: /D');
    expect(RdpSession.releaseDrive(config, new FakeRunner('linux'))).toBe(false);
  });

  test('an mstsc that ends early is visible to the caller', async () => {
    const runner = new FakeRunner();
    const rdp = session(altShellConfig(), runner);
    await rdp.open(async () => {
      runner.launched[0]?.end(7);
    });
    expect(rdp.exited).toEqual({ code: 7 });
    await rdp.close({ graceMs: 0 });
  });
});
