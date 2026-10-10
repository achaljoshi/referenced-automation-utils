import { test, expect } from '@playwright/test';
import { AdapterError } from '../src/adapters/adapter';
import { SmtpClient } from '../src/email/smtpClient';
import { startSmtpTestServer, stopSmtpTestServer, type SmtpTestServerHandle } from '../src/testing';

let server: SmtpTestServerHandle;
let client: SmtpClient;

test.beforeAll(async () => {
  server = await startSmtpTestServer();
  client = new SmtpClient({
    host: server.host,
    port: server.port,
    secure: false,
    auth: { user: server.username, pass: server.password },
  });
});

test.afterAll(async () => {
  client.close();
  await stopSmtpTestServer(server);
});

test.describe('SmtpClient @smoke', () => {
  test('verify() succeeds against a real SMTP server with correct credentials', async () => {
    await expect(client.verify()).resolves.toBe(true);
  });

  test('send() delivers a message the server actually receives and parses', async () => {
    const result = await client.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello from SmtpClient',
      text: 'This is the body.',
    });

    expect(result.accepted).toEqual(['recipient@example.com']);
    expect(result.rejected).toEqual([]);

    const message = server.received.find((m) => m.subject === 'Hello from SmtpClient');
    expect(message).toBeDefined();
    expect(message?.text?.trim()).toBe('This is the body.');
    expect(message?.from?.text).toContain('sender@example.com');
  });

  test('the same connection can send more than one message without reconnecting', async () => {
    await client.send({ from: 'a@example.com', to: 'b@example.com', subject: 'First', text: '1' });
    await client.send({ from: 'a@example.com', to: 'b@example.com', subject: 'Second', text: '2' });

    const subjects = server.received.map((m) => m.subject);
    expect(subjects).toEqual(expect.arrayContaining(['First', 'Second']));
  });

  test('wrong credentials are rejected by the real server, not just assumed', async () => {
    const badClient = new SmtpClient({
      host: server.host,
      port: server.port,
      secure: false,
      auth: { user: server.username, pass: 'wrong-password' },
    });

    // The authentication failure specifically (SMTP 535 / EAUTH), not just "some error": a refused connection or a typo
    // in the host would also reject, and must not let this test pass.
    const error = await badClient.verify().then(
      () => undefined,
      (e: unknown) => e as AdapterError,
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error?.message).toContain('Invalid login');
    expect(error?.cause).toMatchObject({ code: 'EAUTH', responseCode: 535 });
    badClient.close();
  });

  test('an unreachable server is a connection error, distinct from an authentication error', async () => {
    const unreachable = new SmtpClient({ host: '127.0.0.1', port: 1, secure: false, auth: { user: 'u', pass: 'p' } });
    const error = await unreachable.verify().then(
      () => undefined,
      (e: unknown) => e as AdapterError,
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect((error?.cause as { code?: string } | undefined)?.code).toBe('ESOCKET');
    expect(error?.message).not.toContain('Invalid login');
    unreachable.close();
  });
});
