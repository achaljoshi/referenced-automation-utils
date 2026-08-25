import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';

export interface SmtpTestServerHandle {
  server: SMTPServer;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Every message accepted so far, parsed - newest last. */
  received: ParsedMail[];
}

/**
 * A real, in-process SMTP server for testing SmtpClient against - not a
 * live third-party mail service, so it's fast, deterministic, and works
 * offline/in CI. Requires AUTH LOGIN/PLAIN with a fixed username/password
 * (so the test also proves SmtpConfig.auth is actually sent), and parses
 * every accepted message with mailparser so tests can assert on subject/
 * body/recipients without a human reading a mailbox.
 */
export async function startSmtpTestServer(): Promise<SmtpTestServerHandle> {
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

  return { server, host: '127.0.0.1', port, username, password, received };
}

export function stopSmtpTestServer(handle: SmtpTestServerHandle): Promise<void> {
  return new Promise((resolve) => handle.server.close(() => resolve()));
}
