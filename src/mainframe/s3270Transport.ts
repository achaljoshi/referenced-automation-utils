import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { getLogger } from '../logger/logger';
import { parseStatus, Tn3270Error, type Tn3270Reply, type Tn3270Transport } from './types';

export interface S3270Options {
  /** The `s3270` program (the scriptable emulator from the x3270 suite). Default: $S3270_PATH, else 's3270' from PATH. */
  command?: string;
  /** Extra emulator arguments, e.g. ['-model', '3278-2', '-charset', 'bracket']. */
  args?: string[];
  /**
   * Per-command limit - a "the emulator hung" backstop; waiting for the host is the session's job (it raises the limit
   * for the commands that legitimately wait). Default 60 s. A command that exceeds it leaves the emulator in an unknown
   * state (its late answer would be taken for the next command's), so the emulator is stopped and this transport is
   * finished: start a new one.
   */
  requestTimeoutMs?: number;
}

interface Waiting {
  resolve: (reply: Tn3270Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

/**
 * Drives `s3270`, the scriptable 3270 emulator: one command per line on stdin; per command it prints zero or more
 * `data: ...` lines, a status line, then `ok` or `error`. Commands are strictly sequential, so requests are queued.
 * The command text never appears in the logs (a typed password travels in a `String(...)` command).
 */
export class S3270Transport implements Tn3270Transport {
  private readonly log = getLogger('tn3270');
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Array<{
    command: string;
    resolve: Waiting['resolve'];
    reject: Waiting['reject'];
    timeoutMs?: number;
  }> = [];
  private current?: Waiting;
  private lines: string[] = [];
  private exited = false;
  private stoppedAfterTimeout = false;
  private stderrTail = '';
  private readonly command: string;

  constructor(private readonly options: S3270Options = {}) {
    this.command = options.command ?? process.env.S3270_PATH ?? 's3270';
    this.child = spawn(this.command, options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.stderr.on(
      'data',
      (chunk: Buffer) =>
        (this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000)),
    );
    // Writing to an emulator that has just died is an EPIPE 'error' on stdin; unhandled it would kill the whole worker.
    this.child.stdin.on('error', (error) => {
      this.exited = true;
      this.failAll(
        new Tn3270Error(
          `could not write to s3270: ${error.message}${this.stderrTail ? ` (${this.stderrTail.trim()})` : ''}`,
          'EXITED',
        ),
      );
    });
    this.child.on('exit', (code) => this.onExit(code));
    this.child.on('error', (error) => {
      this.exited = true;
      this.failAll(
        new Tn3270Error(
          `could not start s3270 (${this.command}): ${error.message}. Install the x3270 suite or set S3270_PATH.`,
          'EXITED',
        ),
      );
    });
  }

  request(command: string, options: { timeoutMs?: number } = {}): Promise<Tn3270Reply> {
    if (this.exited)
      return Promise.reject(
        new Tn3270Error(
          this.stoppedAfterTimeout
            ? 'the s3270 emulator was stopped after a command timed out; start a new transport'
            : 'the s3270 emulator is not running',
          'EXITED',
        ),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject, timeoutMs: options.timeoutMs });
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift() as (typeof this.queue)[number];
    const limit = next.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      const waiting = this.current;
      this.current = undefined;
      waiting?.reject(
        new Tn3270Error(`no reply to "${commandName(next.command)}" within ${limit}ms`, 'TIMEOUT'),
      );
      // The emulator may still answer later; that answer would be delivered to whatever command comes next. There is
      // no way to tell it apart, so the emulator is stopped rather than trusted again.
      this.stoppedAfterTimeout = true;
      this.exited = true;
      this.failAll(
        new Tn3270Error(
          'the s3270 emulator was stopped after a command timed out; start a new transport',
          'EXITED',
        ),
      );
      this.child.kill();
    }, limit);
    this.current = { resolve: next.resolve, reject: next.reject, timer, command: next.command };
    this.lines = [];
    this.child.stdin.write(`${next.command}\n`);
  }

  private onLine(line: string): void {
    if (this.stoppedAfterTimeout) return; // a late answer from the emulator we stopped
    if (!this.current) {
      this.log.debug(`[tn3270] ignoring unsolicited output: ${line.slice(0, 120)}`);
      return;
    }
    if (line !== 'ok' && line !== 'error') {
      this.lines.push(line);
      return;
    }
    const waiting = this.current;
    this.current = undefined;
    clearTimeout(waiting.timer);
    const statusLine = this.lines.pop() ?? '';
    const data = this.lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    if (line === 'error')
      waiting.reject(
        new Tn3270Error(
          data.join(' ').trim() || `${commandName(waiting.command)} failed`,
          'COMMAND',
        ),
      );
    else waiting.resolve({ data, status: parseStatus(statusLine) });
    this.pump();
  }

  private onExit(code: number | null): void {
    this.exited = true;
    if (this.stoppedAfterTimeout) return; // we stopped it on purpose; everything pending already failed with the reason
    this.failAll(
      new Tn3270Error(
        `s3270 exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`,
        'EXITED',
      ),
    );
  }

  private failAll(error: Error): void {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(error);
      this.current = undefined;
    }
    for (const q of this.queue.splice(0)) q.reject(error);
  }

  async close(): Promise<void> {
    if (!this.exited) {
      await this.request('Quit').catch(() => undefined);
      this.child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 2000);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function commandName(command: string): string {
  return command.replace(/\(.*$/s, '');
}
