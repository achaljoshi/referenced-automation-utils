import { test, expect } from '@playwright/test';
import { findEmailBySubject, selectNewestMatch, type MailCandidate } from '../src/email/emailUtils';
import { startImapTestServer, stopImapTestServer, type ImapTestServerHandle } from '../src/testing';

let server: ImapTestServerHandle;

test.beforeEach(async () => {
  server = await startImapTestServer();
});
test.afterEach(async () => {
  await stopImapTestServer(server);
});

const config = () => ({ host: server.host, port: server.port, secure: false, auth: { user: server.username, pass: server.password } });
const FAST = { timeoutMs: 3000, pollIntervalMs: 50 };
const at = (iso: string) => new Date(iso);

test('smoke: reads the body of a matching unseen message from a real IMAP conversation', async () => {
  server.addMessage({ to: 'a@example.com', subject: 'Your code', text: 'Code: 123456' });
  const body = await findEmailBySubject(config(), 'Your code', FAST);
  expect(body.trim()).toBe('Code: 123456');
});

test('returns the NEWEST matching message, not the oldest the server lists first', async () => {
  server.addMessage({ to: 'a@example.com', subject: 'Your code', text: 'old: 111111', date: at('2026-10-10T08:00:00Z') });
  server.addMessage({ to: 'a@example.com', subject: 'Your code', text: 'newest: 333333', date: at('2026-10-10T10:00:00Z') });
  server.addMessage({ to: 'a@example.com', subject: 'Your code', text: 'middle: 222222', date: at('2026-10-10T09:00:00Z') });
  expect((await findEmailBySubject(config(), 'Your code', FAST)).trim()).toBe('newest: 333333');
});

test('`to` picks out one test\'s message when parallel tests share a mailbox and a subject', async () => {
  server.addMessage({ to: 'alice@example.com', subject: 'OTP', text: 'alice: 111111', date: at('2026-10-10T10:00:00Z') });
  server.addMessage({ to: 'bob@example.com', subject: 'OTP', text: 'bob: 222222', date: at('2026-10-10T11:00:00Z') });
  expect((await findEmailBySubject(config(), 'OTP', { ...FAST, to: 'ALICE@example.com' })).trim()).toBe('alice: 111111');
  expect((await findEmailBySubject(config(), 'OTP', { ...FAST, to: 'bob@example.com' })).trim()).toBe('bob: 222222');
});

test('`since` ignores mail that arrived before it', async () => {
  server.addMessage({ to: 'a@example.com', subject: 'Welcome', text: 'stale', date: at('2026-10-09T10:00:00Z') });
  await expect(findEmailBySubject(config(), 'Welcome', { timeoutMs: 400, pollIntervalMs: 50, since: at('2026-10-10T00:00:00Z') })).rejects.toThrow(
    /No unseen email with subject containing "Welcome" since 2026-10-10T00:00:00.000Z within 400ms/,
  );
  server.addMessage({ to: 'a@example.com', subject: 'Welcome', text: 'fresh', date: at('2026-10-10T10:00:00Z') });
  expect((await findEmailBySubject(config(), 'Welcome', { ...FAST, since: at('2026-10-10T00:00:00Z') })).trim()).toBe('fresh');
});

test('the message is marked seen after it is read, so the next call does not return it again', async () => {
  const uid = server.addMessage({ to: 'a@example.com', subject: 'Once', text: 'only once' });
  expect(server.isSeen(uid)).toBe(false);
  expect((await findEmailBySubject(config(), 'Once', FAST)).trim()).toBe('only once');
  expect(server.isSeen(uid)).toBe(true);
  await expect(findEmailBySubject(config(), 'Once', { timeoutMs: 300, pollIntervalMs: 50 })).rejects.toThrow(/No unseen email/);
});

test('markSeen: false leaves the message unseen', async () => {
  const uid = server.addMessage({ to: 'a@example.com', subject: 'Peek', text: 'still here' });
  await findEmailBySubject(config(), 'Peek', { ...FAST, markSeen: false });
  expect(server.isSeen(uid)).toBe(false);
  expect(server.unseenSubjects()).toEqual(['Peek']);
});

test('waits for a message that arrives while it is polling', async () => {
  setTimeout(() => server.addMessage({ to: 'a@example.com', subject: 'Late', text: 'arrived late' }), 300);
  expect((await findEmailBySubject(config(), 'Late', FAST)).trim()).toBe('arrived late');
});

test('an unrelated subject is not returned, and the timeout error names what was wanted', async () => {
  server.addMessage({ to: 'a@example.com', subject: 'Newsletter', text: 'spam' });
  await expect(findEmailBySubject(config(), 'Your code', { timeoutMs: 300, pollIntervalMs: 50, to: 'a@example.com' })).rejects.toThrow(
    /No unseen email with subject containing "Your code" to a@example.com within 300ms/,
  );
});

test('a wrong password is reported as an authentication failure', async () => {
  const error = (await findEmailBySubject({ ...config(), auth: { user: server.username, pass: 'nope' } }, 'x', FAST).catch((e: unknown) => e)) as Error;
  expect(error.message).toMatch(/IMAP authentication failed for testuser at 127\.0\.0\.1: .*Invalid credentials/);
  expect((error.cause as { authenticationFailed?: boolean }).authenticationFailed).toBe(true);
});

test('a connection dropped while polling surfaces promptly as that error - no hang, no unhandled event, no masking by logout', async () => {
  server.addMessage({ to: 'a@example.com', subject: 'Other', text: 'x' });
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    setTimeout(() => server.dropConnections(), 150);
    const started = Date.now();
    const error = (await findEmailBySubject(config(), 'Never arrives', { timeoutMs: 20_000, pollIntervalMs: 100 }).catch((e: unknown) => e)) as Error;
    expect(Date.now() - started).toBeLessThan(5000); // not the 20 s deadline
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/No unseen email/); // the connection failure itself, not a timeout
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
});

test.describe('selectNewestMatch (the selection rule on its own)', () => {
  const mail = (uid: number, subject: string, recipients: string[], date?: string): MailCandidate => ({ uid, subject, recipients, date: date ? at(date) : undefined });

  test('newest date wins; on equal dates the higher UID wins', () => {
    const list = [mail(1, 'Code', [], '2026-10-10T10:00:00Z'), mail(2, 'Code', [], '2026-10-10T12:00:00Z'), mail(3, 'Code', [], '2026-10-10T12:00:00Z')];
    expect(selectNewestMatch(list, { subjectContains: 'Code' })?.uid).toBe(3);
  });

  test('subject is a case-sensitive substring; recipient is case-insensitive and exact; since is inclusive', () => {
    const list = [mail(1, 'Your Code is ready', ['A@x.com'], '2026-10-10T10:00:00Z'), mail(2, 'your code', ['a@x.com'], '2026-10-10T11:00:00Z')];
    expect(selectNewestMatch(list, { subjectContains: 'Your Code' })?.uid).toBe(1);
    expect(selectNewestMatch(list, { subjectContains: 'ode', to: 'a@X.com' })?.uid).toBe(2);
    expect(selectNewestMatch(list, { subjectContains: 'ode', to: 'a@x.co' })).toBeUndefined();
    expect(selectNewestMatch(list, { subjectContains: 'ode', since: at('2026-10-10T10:00:00Z') })?.uid).toBe(2);
    expect(selectNewestMatch(list, { subjectContains: 'Your Code', since: at('2026-10-10T10:00:01Z') })).toBeUndefined();
  });

  test('a message with no date cannot satisfy `since`, but can be chosen without it; nothing matching gives undefined', () => {
    const list = [mail(1, 'Code', [])];
    expect(selectNewestMatch(list, { subjectContains: 'Code', since: at('2026-01-01T00:00:00Z') })).toBeUndefined();
    expect(selectNewestMatch(list, { subjectContains: 'Code' })?.uid).toBe(1);
    expect(selectNewestMatch([], { subjectContains: 'Code' })).toBeUndefined();
  });
});
