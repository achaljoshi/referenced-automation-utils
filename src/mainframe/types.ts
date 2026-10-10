/** The keyboard state a 3270 terminal reports: unlocked (you may type), locked (the host is still working), error. */
export type KeyboardState = 'unlocked' | 'locked' | 'error';

export interface Tn3270Status {
  keyboard: KeyboardState;
  /** The screen has input fields (a formatted screen) as opposed to plain text. */
  formatted: boolean;
  connected: boolean;
  host?: string;
  rows: number;
  cols: number;
  /** 0-based, as the emulator reports it. */
  cursorRow: number;
  cursorCol: number;
  raw: string;
}

/** One answer from the emulator: the lines it printed and its status line. */
export interface Tn3270Reply {
  data: string[];
  status: Tn3270Status;
}

export class Tn3270Error extends Error {
  constructor(
    message: string,
    readonly code: 'COMMAND' | 'TIMEOUT' | 'EXITED' = 'COMMAND',
  ) {
    super(message);
    this.name = 'Tn3270Error';
  }
}

/**
 * The seam between the session logic and a 3270 emulator. Commands are the scripting commands of the
 * x3270 family (`Connect(host:23)`, `String("x")`, `Enter`, `PF(3)`, `Ascii`, `Wait(30,Unlock)` ...); a reply is
 * what `s3270` prints. Production uses S3270Transport; tests and local trials use FakeMainframe.
 */
export interface Tn3270Transport {
  /** `options.timeoutMs` overrides the transport's own per-command limit for this command (a long `Wait` needs more). */
  request(command: string, options?: { timeoutMs?: number }): Promise<Tn3270Reply>;
  close(): Promise<void>;
}

/** Parses the 12-field status line s3270 prints before `ok` / `error`. */
export function parseStatus(raw: string): Tn3270Status {
  const f = raw.trim().split(/\s+/);
  const connection = f[3] ?? 'N';
  return {
    keyboard: f[0] === 'U' ? 'unlocked' : f[0] === 'L' ? 'locked' : 'error',
    formatted: f[1] === 'F',
    connected: connection.startsWith('C('),
    host: connection.startsWith('C(') ? connection.slice(2, -1) : undefined,
    rows: Number(f[6] ?? 24),
    cols: Number(f[7] ?? 80),
    cursorRow: Number(f[8] ?? 0),
    cursorCol: Number(f[9] ?? 0),
    raw,
  };
}
