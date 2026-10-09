import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { getLogger } from '../logger/logger';
import { parseStatus, Tn3270Error, type Tn3270Reply, type Tn3270Transport } from './types';

export interface S3270Options {
  /** The `s3270` program (the scriptable emulator from the x3270 suite). Default 's3270' from PATH (S3270_PATH). */
  command?: string;
  /** Extra emulator arguments, e.g. ['-model', '3278-2', '-charset', 'bracket']. */
  args?: string[];
  /** Per-command limit - a "the emulator hung" backstop; waiting for the host is the session's job. Default 60 s. */
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
  }> = [];
  private current?: Waiting;
  private lines: string[] = [];
  private exited = false;
  private stderrTail = '';

  constructor(private readonly options: S3270Options = {}) {
    this.child = spawn(options.command ?? 's3270', options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.stderr.on(
      'data',
      (chunk: Buffer) =>
        (this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000)),
    );
    this.child.on('exit', (code) => this.onExit(code));
    this.child.on('error', (error) => {
      this.exited = true;
      this.failAll(
        new Tn3270Error(
          `could not start s3270 (${this.options.command ?? 's3270'}): ${error.message}. Install the x3270 suite or set S3270_PATH.`,
          'EXITED',
        ),
      );
    });
  }

  request(command: string): Promise<Tn3270Reply> {
    if (this.exited)
      return Promise.reject(new Tn3270Error('the s3270 emulator is not running', 'EXITED'));
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift() as (typeof this.queue)[number];
    const limit = this.options.requestTimeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      const waiting = this.current;
      this.current = undefined;
      waiting?.reject(
        new Tn3270Error(`no reply to "${commandName(next.command)}" within ${limit}ms`, 'TIMEOUT'),
      );
      this.pump();
    }, limit);
    this.current = { resolve: next.resolve, reject: next.reject, timer, command: next.command };
    this.lines = [];
    this.child.stdin.write(`${next.command}\n`);
  }

  private onLine(line: string): void {
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
