import { adapterStep, AdapterError, type Adapter } from '../adapters/adapter';
import { getLogger } from '../logger/logger';
import { Tn3270Error, type Tn3270Reply, type Tn3270Status, type Tn3270Transport } from './types';

export interface Tn3270Target {
  host: string;
  /** Default 23 (992 with tls). */
  port?: number;
  /** Connect with TLS (s3270 `L:` prefix). */
  tls?: boolean;
}

export interface Tn3270SessionOptions {
  /** How long to wait for the host (keyboard unlock, expected text). Default 30 000 ms (SAP-style: TN3270_TIMEOUT_MS). */
  timeoutMs?: number;
  /** How often to look while waiting for text. Default 200 ms. */
  pollMs?: number;
}

export interface ScreenMatch {
  /** 1-based, as a person reads the screen. */
  row: number;
  col: number;
  line: string;
  text: string;
}

const log = getLogger('tn3270');

/**
 * A 3270 terminal session driven by scripting commands, with the waiting a hand-written script usually forgets:
 *
 *  - every AID key (Enter, PF, PA, Clear) waits for the keyboard to unlock - i.e. for the host to answer - before it
 *    returns, so the next read can never see the previous screen;
 *  - screen reads always come after that wait;
 *  - `waitForText` polls until the text appears and, if it never does, fails with THE SCREEN AS IT WAS - which is
 *    what you need to know at 2 am in a pipeline;
 *  - typed secrets never reach the log, and every step is logged and timed like any other adapter.
 *
 * Rows and columns in this API are 1-based (as on a screen); the emulator's are 0-based, converted for you.
 */
export class Tn3270Session implements Adapter {
  readonly name = 'tn3270';
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private lastStatus?: Tn3270Status;
  private readonly snaps: Array<{ label: string; text: string }> = [];

  private constructor(
    private readonly transport: Tn3270Transport,
    options: Tn3270SessionOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 200;
  }

  /** Connects and waits for the first screen to be ready for input. */
  static async connect(
    transport: Tn3270Transport,
    target: Tn3270Target,
    options: Tn3270SessionOptions = {},
  ): Promise<Tn3270Session> {
    const session = new Tn3270Session(transport, options);
    const port = target.port ?? (target.tls ? 992 : 23);
    await adapterStep(
      'tn3270',
      'connect',
      async () => {
        await session.send(`Connect(${target.tls ? 'L:' : ''}${target.host}:${port})`);
        await session.waitForUnlock();
      },
      { details: { host: target.host, port, tls: target.tls ?? false } },
    );
    return session;
  }

  private async send(command: string): Promise<Tn3270Reply> {
    const reply = await this.transport.request(command);
    this.lastStatus = reply.status;
    return reply;
  }

  // -------------------------------------------------------------- reading

  /** Waits until the host has answered (keyboard unlocked). Fails, saying so, if it has not within the timeout. */
  async waitForUnlock(timeoutMs = this.timeoutMs): Promise<void> {
    try {
      await this.send(`Wait(${Math.max(1, Math.ceil(timeoutMs / 1000))},Unlock)`);
    } catch (error) {
      if (error instanceof Tn3270Error && /timed out/i.test(error.message)) {
        throw await this.failure(
          'waitForUnlock',
          `the keyboard is still locked after ${timeoutMs}ms - the host is not answering`,
        );
      }
      throw error;
    }
  }

  /** The screen's rows, after waiting for the host - never the previous screen. */
  async screen(): Promise<string[]> {
    await this.waitForUnlock();
    return this.peekScreen();
  }

  /** The screen as it is right now, without waiting (it may be the previous screen if the host has not answered). */
  async peekScreen(): Promise<string[]> {
    return (await this.send('Ascii')).data;
  }

  async screenText(): Promise<string> {
    return (await this.screen()).join('\n');
  }

  /** Where `pattern` is on the screen right now (after waiting for the host), or undefined. */
  async find(
    pattern: string | RegExp,
    options: { ignoreCase?: boolean } = {},
  ): Promise<ScreenMatch | undefined> {
    return findIn(await this.screen(), pattern, options.ignoreCase ?? false);
  }

  /**
   * Polls until `pattern` is on the screen. On timeout the error shows the screen as it was, so a wrong password, an
   * unexpected error line or a different screen is visible in the failure itself.
   */
  async waitForText(
    pattern: string | RegExp,
    options: { timeout?: number; ignoreCase?: boolean } = {},
  ): Promise<ScreenMatch> {
    const timeout = options.timeout ?? this.timeoutMs;
    return this.step('waitForText', { pattern: String(pattern) }, async () => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = findIn(await this.screen(), pattern, options.ignoreCase ?? false);
        if (found) return found;
        if (Date.now() >= deadline)
          throw await this.failure(
            'waitForText',
            `${String(pattern)} did not appear within ${timeout}ms`,
          );
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    });
  }

  /** Polls until `pattern` is gone. */
  async waitForNoText(
    pattern: string | RegExp,
    options: { timeout?: number; ignoreCase?: boolean } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? this.timeoutMs;
    await this.step('waitForNoText', { pattern: String(pattern) }, async () => {
      const deadline = Date.now() + timeout;
      while (findIn(await this.screen(), pattern, options.ignoreCase ?? false)) {
        if (Date.now() >= deadline)
          throw await this.failure(
            'waitForNoText',
            `${String(pattern)} was still on the screen after ${timeout}ms`,
          );
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    });
  }

  // -------------------------------------------------------------- typing

  /** Types at the cursor. `secret: true` keeps the text out of the logs and the journal. */
  async type(text: string, options: { secret?: boolean } = {}): Promise<void> {
    if (/[\n\r\t]/.test(text))
      throw new AdapterError(
        this.name,
        'type',
        'text may not contain a newline or tab - use enter() / tab() so the host is waited for',
      );
    await this.step('type', { text: options.secret ? '[REDACTED]' : text }, async () => {
      await this.send(`String("${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`);
    });
  }

  /** Moves the cursor to (row, col) - 1-based - and types there. */
  async typeAt(
    row: number,
    col: number,
    text: string,
    options: { secret?: boolean } = {},
  ): Promise<void> {
    await this.step('moveCursor', { row, col }, async () => {
      await this.send(`MoveCursor(${row - 1},${col - 1})`);
    });
    await this.type(text, options);
  }

  /**
   * Finds `label` on the screen and types into the input field that follows it (replacing what is there):
   * the way a person fills a form, and robust against the layout moving.
   */
  async fillAfterLabel(
    label: string,
    value: string,
    options: { secret?: boolean; keepExisting?: boolean } = {},
  ): Promise<void> {
    const where = await this.waitForText(label);
    await this.step(
      'fillAfterLabel',
      { label, value: options.secret ? '[REDACTED]' : value },
      async () => {
        // the last character of the label, then Tab to the next input field - works whether or not a gap separates them
        await this.send(`MoveCursor(${where.row - 1},${where.col - 1 + label.length - 1})`);
        await this.send('Tab');
        if (!options.keepExisting) await this.send('EraseEOF');
      },
    );
    await this.type(value, { secret: options.secret });
  }

  // -------------------------------------------------------------- AID keys

  /** Presses Enter and waits for the host to answer. */
  async enter(): Promise<void> {
    await this.aid('Enter');
  }

  /** PF key (1-24) and wait for the host. */
  async pf(n: number): Promise<void> {
    await this.aid(`PF(${n})`);
  }

  async pa(n: number): Promise<void> {
    await this.aid(`PA(${n})`);
  }

  async clear(): Promise<void> {
    await this.aid('Clear');
  }

  async tab(): Promise<void> {
    await this.step('tab', {}, async () => void (await this.send('Tab')));
  }

  private async aid(command: string): Promise<void> {
    await this.step(
      command.toLowerCase().replace(/\(.*\)/, ''),
      command.includes('(') ? { key: command } : {},
      async () => {
        await this.send(command);
        await this.waitForUnlock();
      },
    );
  }

  // -------------------------------------------------------------- diagnostics

  /** Keeps a text copy of the screen under `label`, for the test report. */
  async snapshot(label: string): Promise<string> {
    const text = await this.screenText();
    this.snaps.push({ label, text });
    return text;
  }

  get snapshots(): ReadonlyArray<{ label: string; text: string }> {
    return this.snaps;
  }

  get status(): Tn3270Status | undefined {
    return this.lastStatus;
  }

  // -------------------------------------------------------------- Adapter

  async healthCheck(): Promise<boolean> {
    try {
      return (await this.send('Ascii(0,0,1,1)')).status.connected;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.send('Disconnect').catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.disconnect();
    await this.transport.close();
  }

  // -------------------------------------------------------------- internals

  private async step<T>(
    operation: string,
    details: Record<string, unknown>,
    action: () => Promise<T>,
  ): Promise<T> {
    return adapterStep(this.name, operation, action, { details });
  }

  private async failure(operation: string, message: string): Promise<AdapterError> {
    let dump = '(the screen could not be read)';
    try {
      dump = (await this.peekScreen())
        .map((l, i) => `${String(i + 1).padStart(2)} | ${l.trimEnd()}`)
        .join('\n');
    } catch (error) {
      log.debug(`[tn3270] could not read the screen for the failure message: ${String(error)}`);
    }
    const s = this.lastStatus;
    return new AdapterError(
      this.name,
      operation,
      `${message}. Keyboard ${s?.keyboard ?? 'unknown'}, cursor row ${s ? s.cursorRow + 1 : '?'} col ${s ? s.cursorCol + 1 : '?'}. The screen was:\n${dump}`,
    );
  }
}

function findIn(
  rows: string[],
  pattern: string | RegExp,
  ignoreCase: boolean,
): ScreenMatch | undefined {
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i] as string;
    if (typeof pattern === 'string') {
      const at = ignoreCase
        ? line.toLowerCase().indexOf(pattern.toLowerCase())
        : line.indexOf(pattern);
      if (at !== -1)
        return { row: i + 1, col: at + 1, line, text: line.slice(at, at + pattern.length) };
    } else {
      const m = pattern.exec(line);
      if (m) return { row: i + 1, col: m.index + 1, line, text: m[0] };
    }
  }
  return undefined;
}
