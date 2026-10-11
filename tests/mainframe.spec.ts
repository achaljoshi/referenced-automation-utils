import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { mainframe } from '../src';

const { Tn3270Session, S3270Transport, createSampleMainframe, parseStatus, Tn3270Error } = mainframe;
const FAST = { timeoutMs: 2000, pollMs: 20 };
const connect = async (options: Parameters<typeof createSampleMainframe>[0] = {}) => {
  const host = createSampleMainframe({ unlockDelayMs: 100, ...options });
  return { host, session: await Tn3270Session.connect(host, { host: 'mainframe.test' }, FAST) };
};

async function logon(session: mainframe.Tn3270Session, password = 'correct-horse') {
  await session.fillAfterLabel('USERID', 'TESTUSER');
  await session.fillAfterLabel('PASSWORD', password, { secret: true });
  await session.enter();
}

test.describe('status line', () => {
  test('is parsed: keyboard, connection, size and cursor', () => {
    expect(parseStatus('U F U C(host.example) I 4 24 80 3 17 0x0 -')).toMatchObject({ keyboard: 'unlocked', formatted: true, connected: true, host: 'host.example', rows: 24, cols: 80, cursorRow: 3, cursorCol: 17 });
    expect(parseStatus('L U P N I 4 24 80 0 0 0x0 -')).toMatchObject({ keyboard: 'locked', formatted: false, connected: false });
  });
});

test.describe('a 3270 session that waits for the host', () => {
  test('logon, account inquiry and back, written as a person would do it', async () => {
    const { session } = await connect();
    await session.waitForText('WELCOME TO THE TEST MAINFRAME');
    await logon(session);
    await session.waitForText('MAIN MENU');
    await session.fillAfterLabel('ACCOUNT NUMBER', '123456');
    await session.enter();
    const balance = await session.waitForText(/BALANCE\s+([\d,.]+ GBP)/);
    expect(balance.text).toBe('BALANCE  1,234.56 GBP');
    await session.pf(3);
    await session.waitForText('MAIN MENU');
    await session.close();
  });

  test('negative control: WITHOUT the wait, a read straight after Enter is the PREVIOUS screen', async () => {
    const host = createSampleMainframe({ unlockDelayMs: 200 });
    await host.request('Connect(h:23)');
    await host.request('String("TESTUSER")');
    await host.request('Tab');
    await host.request('String("correct-horse")');
    await host.request('Enter');
    const stale = (await host.request('Ascii')).data.join('\n');
    expect(stale).toContain('WELCOME TO THE TEST MAINFRAME'); // still the logon screen: the host has not answered yet
    expect(stale).not.toContain('MAIN MENU');
  });

  test('with the session, enter() returns only after the host answered, so the very next read is the new screen', async () => {
    const { session } = await connect({ unlockDelayMs: 200 });
    await logon(session);
    expect(await session.screenText()).toContain('MAIN MENU'); // no waitForText needed: the AID key already waited
  });

  test('a failure shows the screen as it was - a wrong password is visible in the error itself', async () => {
    const { session } = await connect();
    await logon(session, 'wrong-password');
    const error = (await session.waitForText('MAIN MENU', { timeout: 300 }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('did not appear within 300ms');
    expect(error.message).toContain('The screen was:');
    expect(error.message).toContain('INVALID USERID OR PASSWORD');
    expect(error.message).toMatch(/Keyboard unlocked, cursor row \d+ col \d+/);
  });

  test('typed secrets are not in the log or the journal', async () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      const { session } = await connect();
      await logon(session, 'hunter2-secret');
    } finally {
      process.stdout.write = original;
    }
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('hunter2-secret');
  });

  test('rows and columns are 1-based, like the screen: find, typeAt', async () => {
    const { session, host } = await connect();
    const where = await session.find('USERID');
    expect(where).toMatchObject({ row: 4, col: 4 }); // "   USERID": 3 spaces, so column 4
    await session.typeAt(4, 18, 'ABC');
    expect(host.commands).toContain('MoveCursor(3,17)');
    expect(await session.screenText()).toContain('ABC');
  });

  test('fillAfterLabel replaces what is in the field, unless keepExisting', async () => {
    const { session } = await connect();
    await session.fillAfterLabel('USERID', 'FIRST');
    await session.fillAfterLabel('USERID', 'SECOND');
    expect((await session.screenText()).match(/USERID\s+===>\s+(\w+)/)?.[1]).toBe('SECOND');
    // keepExisting: not erased first, so typing overwrites from the start of the field (3270 overtype mode)
    await session.fillAfterLabel('USERID', 'X', { keepExisting: true });
    expect((await session.screenText()).match(/USERID\s+===>\s+(\w+)/)?.[1]).toBe('XECOND');
  });

  test('quotes and backslashes are escaped; a newline or tab is refused (it would press a key the host is not waited for)', async () => {
    const { session, host } = await connect();
    await session.fillAfterLabel('USERID', 'a"b\\c');
    expect(host.commands).toContain('String("a\\"b\\\\c")');
    await expect(session.type('line1\nline2')).rejects.toThrow(/may not contain a newline or tab/);
  });

  test('waitForNoText polls until the text is gone', async () => {
    const { session } = await connect({ unlockDelayMs: 100 });
    await logon(session);
    await session.waitForNoText('WELCOME TO THE TEST MAINFRAME', { timeout: 1000 });
  });

  test('a host that never unlocks the keyboard is reported as such, with the screen', async () => {
    const host = createSampleMainframe({ unlockDelayMs: 5000 });
    const slow = await Tn3270Session.connect(host, { host: 'h' }, { timeoutMs: 1000, pollMs: 20 });
    await slow.fillAfterLabel('USERID', 'TESTUSER');
    await slow.fillAfterLabel('PASSWORD', 'correct-horse', { secret: true });
    const error = (await slow.enter().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('the keyboard is still locked after 1000ms - the host is not answering');
    expect(error.message).toContain('The screen was:');
  });

  test('health check follows the connection', async () => {
    const { session } = await connect();
    expect(await session.healthCheck()).toBe(true);
    await session.disconnect();
    expect(await session.healthCheck()).toBe(false);
  });

  test('snapshots keep a text copy of the screen for the report', async () => {
    const { session } = await connect();
    const text = await session.snapshot('logon screen');
    expect(text).toContain('USERID');
    expect(session.snapshots.map((s) => s.label)).toEqual(['logon screen']);
  });
});

test.describe('S3270Transport over a real process speaking the s3270 line protocol', () => {
  const standIn = path.resolve(__dirname, 'bridges/fakeS3270.js');
  const start = (env: NodeJS.ProcessEnv = {}, options: { requestTimeoutMs?: number } = {}) => {
    Object.assign(process.env, env);
    const transport = new S3270Transport({ command: process.execPath, args: [standIn], ...options });
    for (const key of Object.keys(env)) delete process.env[key];
    return transport;
  };

  test('commands round-trip: data lines and the status line are parsed', async () => {
    const transport = start();
    const connected = await transport.request('Connect(mainframe.test:23)');
    expect(connected.status).toMatchObject({ connected: true, host: 'mainframe.test', keyboard: 'unlocked' });
    const screen = await transport.request('Ascii');
    expect(screen.data).toHaveLength(24);
    expect(screen.data.join('\n')).toContain('WELCOME TO THE TEST MAINFRAME');
    await transport.close();
  });

  test('an `error` reply becomes a Tn3270Error carrying the emulator\'s message', async () => {
    const transport = start();
    const error = (await transport.request('Enter').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(error).toBeInstanceOf(Tn3270Error);
    expect(error.code).toBe('COMMAND');
    expect(error.message).toContain('not connected');
    await transport.close();
  });

  test('concurrent requests are answered in order, one at a time', async () => {
    const transport = start();
    await transport.request('Connect(h:23)');
    const [a, b, c] = await Promise.all([transport.request('Ascii(0,0,1,10)'), transport.request('Ascii(1,3,1,10)'), transport.request('Ascii(3,3,1,8)')]);
    expect(a.data[0]?.trim()).toBe('');
    expect(b.data[0]).toContain('WELCOME');
    expect(c.data[0]).toContain('USERID');
    await transport.close();
  });

  test('a command the emulator never answers times out', async () => {
    const transport = start({ S3270_HANG: 'Home' }, { requestTimeoutMs: 300 });
    await transport.request('Connect(h:23)');
    const error = (await transport.request('Home').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('no reply to "Home" within 300ms');
    await transport.close();
  });

  test('after a timeout the emulator is stopped and the transport is finished: a LATE reply can never answer the next request', async () => {
    const transport = start({ S3270_SLOW: 'Home:500' }, { requestTimeoutMs: 150 });
    await transport.request('Connect(h:23)', { timeoutMs: 10_000 });
    const timedOut = (await transport.request('Home').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(timedOut.code).toBe('TIMEOUT');
    // the old transport kept going: Home's late "ok" (at 500 ms) was delivered as the answer to this Ascii
    const next = (await transport.request('Ascii').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(next).toBeInstanceOf(Tn3270Error);
    expect(next.code).toBe('EXITED');
    expect(next.message).toMatch(/stopped after a command timed out/);
    await new Promise((resolve) => setTimeout(resolve, 700)); // past the moment the late reply would have arrived
    const later = (await transport.request('Ascii').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(later.code).toBe('EXITED');
    const pid = (transport as unknown as { child: { pid: number } }).child.pid;
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive'; } catch { return 'gone'; } }, { timeout: 3000 }).toBe('gone');
  });

  test('queued commands fail with the reason when an earlier one times out', async () => {
    const transport = start({ S3270_HANG: 'Home' }, { requestTimeoutMs: 150 });
    await transport.request('Connect(h:23)', { timeoutMs: 10_000 });
    const results = await Promise.all([transport.request('Home'), transport.request('Ascii'), transport.request('Tab')].map((p) => p.catch((e: unknown) => e as mainframe.Tn3270Error)));
    expect(results.map((r) => (r as mainframe.Tn3270Error).code)).toEqual(['TIMEOUT', 'EXITED', 'EXITED']);
  });

  test('a per-request timeout overrides the transport default', async () => {
    const transport = start({ S3270_HANG: 'Home' }, { requestTimeoutMs: 5000 });
    await transport.request('Connect(h:23)');
    const started = Date.now();
    const error = (await transport.request('Home', { timeoutMs: 120 }).catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(error.message).toContain('within 120ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('writing to an emulator that has just died is an error on the request, not an uncaught EPIPE that kills the worker', async () => {
    const transport = start();
    await transport.request('Connect(h:23)');
    const child = (transport as unknown as { child: { kill(signal: string): void } }).child;
    child.kill('SIGKILL');
    // straight away, before the exit event has been processed: the write hits a closed pipe
    const error = (await transport.request('Ascii').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(error).toBeInstanceOf(Tn3270Error);
    expect(error.code).toBe('EXITED');
    await new Promise((resolve) => setTimeout(resolve, 200)); // an unhandled 'error' event would surface as an uncaught exception here
  });

  test('S3270_PATH names the emulator program when no command is given', async () => {
    process.env.S3270_PATH = process.execPath;
    let transport: mainframe.S3270Transport;
    try {
      transport = new S3270Transport({ args: [standIn] });
    } finally {
      delete process.env.S3270_PATH;
    }
    expect((await transport.request('Connect(h:23)')).status.connected).toBe(true);
    await transport.close();
  });

  test('an emulator that dies fails the pending command with its stderr, and later ones fast', async () => {
    const transport = start({ S3270_CRASH: 'Ascii' });
    await transport.request('Connect(h:23)');
    const died = (await transport.request('Ascii').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(died.code).toBe('EXITED');
    expect(died.message).toContain('s3270 exited (code 3)');
    expect(died.message).toContain('fake s3270 crashed on Ascii');
    const later = (await transport.request('Ascii').catch((e: unknown) => e)) as mainframe.Tn3270Error;
    expect(later.code).toBe('EXITED');
  });

  test('a missing s3270 program says how to get it', async () => {
    const transport = new S3270Transport({ command: '/definitely/not/s3270' });
    const error = (await transport.request('Ascii').catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/could not start s3270.*Install the x3270 suite or set S3270_PATH/);
  });

  test('a whole session over the process: logon and account inquiry', async () => {
    const transport = start({ S3270_DELAY_MS: '100' });
    const session = await Tn3270Session.connect(transport, { host: 'mainframe.test' }, FAST);
    await logon(session);
    await session.waitForText('MAIN MENU');
    await session.fillAfterLabel('ACCOUNT NUMBER', '654321');
    await session.enter();
    await session.waitForText('GRACE HOPPER');
    await session.close();
  });
});

test.describe('waiting: one overall deadline, and the transport waits longer than the session', () => {
  const waitCommands = (host: { commands: string[] }) => host.commands.filter((c) => c.startsWith('Wait('));

  test('waitForText({ timeout }) is bounded by that timeout, not by the session timeout once per poll', async () => {
    const host = createSampleMainframe({ unlockDelayMs: 1500 });
    const session = await Tn3270Session.connect(host, { host: 'h' }, { timeoutMs: 30_000, pollMs: 20 });
    await session.fillAfterLabel('USERID', 'TESTUSER');
    await session.fillAfterLabel('PASSWORD', 'correct-horse', { secret: true });
    await host.request('Enter');
    host.commands.length = 0;
    const started = Date.now();
    const error = (await session.waitForText('NEVER ON SCREEN', { timeout: 2000 }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('NEVER ON SCREEN did not appear within 2000ms');
    expect(Date.now() - started).toBeLessThan(5000);
    // every wait for the keyboard was bounded by the time left, never the session's 30 s
    const seconds = waitCommands(host).map((c) => Number(/Wait\((\d+),/.exec(c)?.[1]));
    expect(seconds.length).toBeGreaterThan(0);
    expect(Math.max(...seconds)).toBeLessThanOrEqual(2);
  });

  test('waitForNoText is bounded the same way', async () => {
    const { session, host } = await connect({ unlockDelayMs: 0 });
    host.commands.length = 0;
    const error = (await session.waitForNoText('WELCOME TO THE TEST MAINFRAME', { timeout: 400 }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('was still on the screen after 400ms');
    expect(Math.max(...waitCommands(host).map((c) => Number(/Wait\((\d+),/.exec(c)?.[1])))).toBeLessThanOrEqual(1);
  });

  test('a host that stays locked inside waitForText gives the friendly error with the screen, naming the wait', async () => {
    const host = createSampleMainframe({ unlockDelayMs: 60_000 });
    const session = await Tn3270Session.connect(host, { host: 'h' }, { timeoutMs: 1000, pollMs: 20 });
    await session.fillAfterLabel('USERID', 'TESTUSER');
    await session.fillAfterLabel('PASSWORD', 'correct-horse', { secret: true });
    await host.request('Enter');
    const error = (await session.waitForText('MAIN MENU', { timeout: 1500 }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('MAIN MENU did not appear within 1500ms - the keyboard stayed locked');
    expect(error.message).toContain('The screen was:');
  });

  test('the transport is given longer than the Wait it carries, so the session reports the timeout, with the screen', async () => {
    const host = createSampleMainframe({});
    const seen: Array<{ command: string; timeoutMs?: number }> = [];
    const recording: mainframe.Tn3270Transport = {
      request: (command, options) => (seen.push({ command, timeoutMs: options?.timeoutMs }), host.request(command)),
      close: () => host.close(),
    };
    const session = await Tn3270Session.connect(recording, { host: 'h' }, { timeoutMs: 90_000, pollMs: 20 });
    await session.waitForUnlock(90_000);
    const wait = seen.find((s) => s.command === 'Wait(90,Unlock)');
    expect(wait?.timeoutMs).toBeGreaterThan(90_000);
  });

  test('TN3270_TIMEOUT_MS sets the default session timeout; a bad value is rejected', async () => {
    process.env.TN3270_TIMEOUT_MS = '7000';
    try {
      const host = createSampleMainframe({});
      const session = await Tn3270Session.connect(host, { host: 'h' });
      await session.waitForUnlock();
      expect(host.commands).toContain('Wait(7,Unlock)');
      process.env.TN3270_TIMEOUT_MS = 'soon';
      await expect(Tn3270Session.connect(createSampleMainframe({}), { host: 'h' })).rejects.toThrow(/TN3270_TIMEOUT_MS "soon"/);
    } finally {
      delete process.env.TN3270_TIMEOUT_MS;
    }
  });
});
