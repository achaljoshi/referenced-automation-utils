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
