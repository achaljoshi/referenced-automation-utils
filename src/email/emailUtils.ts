import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as nodemailer from 'nodemailer';
import { adapterStep } from '../adapters/adapter';

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
  try {
    await adapterStep('smtp', 'sendEmail', () => transporter.sendMail(message), {
      details: { to: message.to, subject: message.subject },
    });
  } finally {
    transporter.close();
  }
}

export interface FindEmailOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Only messages addressed (To or Cc) to this address - essential when parallel tests share one mailbox and one subject. */
  to?: string;
  /** Only messages that arrived at or after this moment - ignores mail left over from earlier runs. */
  since?: Date;
  /** Mark the message as read (\\Seen) once it has been returned, so no other test or later run picks it up. Default true. */
  markSeen?: boolean;
}

/** What selection needs to know about one message. */
export interface MailCandidate {
  uid: number;
  subject?: string;
  /** To and Cc addresses. */
  recipients: string[];
  /** When it arrived (the server's internal date, else the Date header). */
  date?: Date;
}

/**
 * The message `findEmailBySubject` should return among `candidates`: those whose subject contains `subjectContains`,
 * that are addressed to `to` (if given) and arrived at or after `since` (if given) - and of those the NEWEST (latest
 * date, the highest UID on a tie), not the first the server happens to list.
 */
export function selectNewestMatch(
  candidates: MailCandidate[],
  criteria: { subjectContains: string; to?: string; since?: Date },
): MailCandidate | undefined {
  const to = criteria.to?.trim().toLowerCase();
  let best: MailCandidate | undefined;
  for (const mail of candidates) {
    if (!mail.subject?.includes(criteria.subjectContains)) continue;
    if (to && !mail.recipients.some((address) => address.toLowerCase() === to)) continue;
    if (criteria.since && (!mail.date || mail.date.getTime() < criteria.since.getTime())) continue;
    const newer =
      !best ||
      (mail.date?.getTime() ?? 0) > (best.date?.getTime() ?? 0) ||
      ((mail.date?.getTime() ?? 0) === (best.date?.getTime() ?? 0) && mail.uid > best.uid);
    if (newer) best = mail;
  }
  return best;
}

/**
 * Searches the inbox for the most recent unseen message whose subject
 * contains `subjectContains` (e.g. an OTP/verification email), returning
 * its plain-text body. Common in test automation for "verify the email that
 * was just triggered" assertions without a human reading a mailbox.
 *
 * With `to` and `since` it picks out YOUR message when several tests share a
 * mailbox and a subject; the newest match wins; and the message is marked read
 * afterwards (`markSeen: false` keeps it unseen) so it is never handed to the
 * next test. A connection error surfaces as itself, not as a logout failure.
 */
export async function findEmailBySubject(
  config: ImapConfig,
  subjectContains: string,
  options: FindEmailOptions = {},
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
  // ImapFlow reports a dropped connection as an 'error' EVENT; with no listener it is an uncaught exception.
  let connectionError: Error | undefined;
  let onConnectionError: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    onConnectionError = reject;
  });
  failed.catch(() => undefined); // observed below; never an unhandled rejection by itself
  client.on('error', (error: Error) => {
    connectionError ??= error;
    onConnectionError(error);
  });
  const orFail = <T>(work: Promise<T>): Promise<T> => Promise.race([work, failed]);

  try {
    await orFail(client.connect());
  } catch (error) {
    const failure = error as { authenticationFailed?: boolean; responseText?: string; message?: string };
    throw failure.authenticationFailed
      ? new Error(
          `IMAP authentication failed for ${config.auth.user} at ${config.host}: ${failure.responseText ?? failure.message}`,
          { cause: error },
        )
      : (connectionError ?? error);
  }
  try {
    while (Date.now() < deadline) {
      const body = await orFail(pollOnce(client, subjectContains, options));
      if (body !== undefined) return body;
      await orFail(new Promise((resolve) => setTimeout(resolve, pollIntervalMs)));
    }
    throw new Error(
      `No unseen email with subject containing "${subjectContains}"${options.to ? ` to ${options.to}` : ''}${options.since ? ` since ${options.since.toISOString()}` : ''} within ${timeoutMs}ms`,
    );
  } catch (error) {
    throw connectionError ?? error;
  } finally {
    // A failing logout (the connection is already gone) must not replace the real error.
    await client.logout().catch(() => client.close());
  }
}

async function pollOnce(
  client: ImapFlow,
  subjectContains: string,
  options: FindEmailOptions,
): Promise<string | undefined> {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const unseen = await client.search({ seen: false }, { uid: true });
    if (!unseen || unseen.length === 0) return undefined;
    const candidates: MailCandidate[] = [];
    for await (const message of client.fetch(unseen, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
      const internal = message.internalDate;
      candidates.push({
        uid: message.uid,
        subject: message.envelope?.subject,
        recipients: [...(message.envelope?.to ?? []), ...(message.envelope?.cc ?? [])]
          .map((a) => a.address)
          .filter((a): a is string => Boolean(a)),
        date:
          internal !== undefined
            ? new Date(internal)
            : message.envelope?.date
              ? new Date(message.envelope.date)
              : undefined,
      });
    }
    const chosen = selectNewestMatch(candidates, { subjectContains, to: options.to, since: options.since });
    if (!chosen) return undefined;
    const full = await client.fetchOne(String(chosen.uid), { source: true }, { uid: true });
    if (!full || !full.source) return undefined;
    const parsed = await simpleParser(full.source);
    if (options.markSeen ?? true) await client.messageFlagsAdd(String(chosen.uid), ['\\Seen'], { uid: true });
    return parsed.text ?? parsed.html?.toString() ?? '';
  } finally {
    lock.release();
  }
}
