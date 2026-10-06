import * as nodemailer from 'nodemailer';
import { adapterStep, type Adapter } from '../adapters/adapter';
import type { SmtpConfig } from './emailUtils';

export interface EmailMessage {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content?: string | Buffer; path?: string }>;
}

export interface SentEmail {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/**
 * A reusable SMTP connection for sending several emails without
 * re-authenticating on every call - unlike emailUtils.sendEmail(), which
 * opens and discards a new connection per message. Connection details
 * (host/port/auth) are supplied by the caller at construction time, same
 * as every other client in this framework (see DbClient) - this class
 * never reads env vars or stores real credentials itself; the consuming
 * repo's own .env.<name> file is where those belong.
 *
 * ```ts
 * const env = loadEnv();
 * const smtp = new SmtpClient({
 *   host: env.get('SMTP_HOST'),
 *   port: env.getInt('SMTP_PORT'),
 *   secure: env.getBoolean('SMTP_SECURE'),
 *   auth: { user: env.get('SMTP_USER'), pass: env.get('SMTP_PASS') },
 * });
 * await smtp.verify();
 * await smtp.send({ from: '...', to: '...', subject: '...', text: '...' });
 * smtp.close();
 * ```
 */
export class SmtpClient implements Adapter {
  readonly name = 'smtp';
  private readonly transporter: nodemailer.Transporter;

  constructor(config: SmtpConfig) {
    this.transporter = nodemailer.createTransport(config);
  }

  /** Verifies the connection/credentials without sending anything. */
  async verify(): Promise<boolean> {
    return adapterStep(this.name, 'verify', () => this.transporter.verify());
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.verify();
    } catch {
      return false;
    }
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    const info = await adapterStep(this.name, 'send', () => this.transporter.sendMail(message), {
      details: { to: message.to, subject: message.subject },
    });
    return {
      messageId: info.messageId,
      accepted: info.accepted as string[],
      rejected: info.rejected as string[],
    };
  }

  /** Closes the underlying connection pool - call once done sending. */
  close(): void {
    this.transporter.close();
  }
}
