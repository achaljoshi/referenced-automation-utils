import type { ParsedMail } from 'mailparser';

export interface SmtpTestServerHandle {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Every message accepted so far, parsed - newest last. */
  received: ParsedMail[];
  stop(): Promise<void>;
}

/**
 * A real, in-process SMTP server for testing anything that sends email -
 * SmtpClient, or an application under test pointed at it. Not a live mail
 * service, so it's fast, deterministic, and works offline/in CI. Requires
 * AUTH with a fixed username/password (so tests also prove the credentials
 * are actually sent) and parses every accepted message with mailparser so a
 * test can assert on subject/body/recipients without a human reading a
 * mailbox.
 *
 * Loaded lazily: `smtp-server` is only required when this function is
 * called, so importing @automation/referenced-automation-utils never pays
 * for it.
 */
export async function startSmtpTestServer(): Promise<SmtpTestServerHandle> {
  // require, not import(): see sftpTestServer.ts - same CommonJS interop reason.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { SMTPServer } = require('smtp-server') as typeof import('smtp-server');
  const { simpleParser } = require('mailparser') as typeof import('mailparser');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const username = 'testuser';
  const password = 'testpass';
  const received: ParsedMail[] = [];

  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (auth.username === username && auth.password === password) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid credentials'));
      }
    },
    onData(stream, _session, callback) {
      simpleParser(stream)
        .then((parsed) => {
          received.push(parsed);
          callback();
        })
        .catch((err: Error) => callback(err));
    },
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    host: '127.0.0.1',
    port,
    username,
    password,
    received,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function stopSmtpTestServer(handle: SmtpTestServerHandle): Promise<void> {
  return handle.stop();
}
