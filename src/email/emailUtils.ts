import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
}

export interface ImapConfig {
  host: string;
  port?: number;
  secure?: boolean;
  auth: { user: string; pass: string };
}

/** Sends an email - used to trigger the flow under test, not to assert on. */
export async function sendEmail(
  config: SmtpConfig,
  message: { from: string; to: string; subject: string; text?: string; html?: string },
): Promise<void> {
  const transporter = nodemailer.createTransport(config);
  await transporter.sendMail(message);
}

/**
 * Searches the inbox for the most recent unseen message whose subject
 * contains `subjectContains` (e.g. an OTP/verification email), returning
 * its plain-text body. Common in test automation for "verify the email that
 * was just triggered" assertions without a human reading a mailbox.
 */
export async function findEmailBySubject(
  config: ImapConfig,
  subjectContains: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  const client = new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    auth: config.auth,
    logger: false,
  });

  await client.connect();
  try {
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const message of client.fetch(
          { seen: false },
          { envelope: true, source: true },
        )) {
          if (message.envelope?.subject?.includes(subjectContains) && message.source) {
            const parsed = await simpleParser(message.source);
            return parsed.text ?? parsed.html?.toString() ?? '';
          }
        }
      } finally {
        lock.release();
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`No unseen email with subject containing "${subjectContains}" within ${timeoutMs}ms`);
  } finally {
    await client.logout();
  }
}
