import { Tn3270Error, type Tn3270Reply, type Tn3270Transport } from './types';

/** An input (unprotected) field. Row and column are 1-based, as a person reads the screen. */
export interface FakeField {
  name: string;
  row: number;
  col: number;
  length: number;
  /** Typed text is not shown (a password). */
  hidden?: boolean;
}

export interface FakeScreenDef {
  name: string;
  /** The text rows; shorter rows are padded. Row 1 is the first entry. */
  lines: string[];
  fields?: FakeField[];
  /** Enter was pressed: return the name of the next screen (or nothing to stay). Receives what is typed in each field. */
  onEnter?: (values: Record<string, string>) => string | undefined;
  onPF?: Record<number, (values: Record<string, string>) => string | undefined>;
}

export interface FakeMainframeOptions {
  start: string;
  screens: FakeScreenDef[];
  /**
   * How long the keyboard stays locked after an AID key (Enter, PF, PA, Clear) while the "host" answers - during
   * which the old screen is still shown. This is what makes the simulator faithful: the mistake a 3270 script
   * makes is reading or typing before the host has replied.
   */
  unlockDelayMs?: number;
}

const ROWS = 24;
const COLS = 80;

/**
 * An in-memory 3270 host + emulator: same scripting commands and replies as s3270, driven by a small screen model.
 * For the framework's own tests and for trying a script without a mainframe - it only knows the screens you give
 * it, so it proves the session logic, NOT that a script matches your host.
 */
export class FakeMainframe implements Tn3270Transport {
  /** Every command received, in order. */
  readonly commands: string[] = [];
  private connected = false;
  private host = '';
  private current: FakeScreenDef;
  private values: Record<string, string> = {};
  private cursor = { row: 0, col: 0 }; // 0-based
  private lockedUntil = 0;
  private pending: string | undefined;

  constructor(private readonly options: FakeMainframeOptions) {
    this.current = this.screen(options.start);
    this.arrive();
  }

  get currentScreen(): string {
    this.tick();
    return this.current.name;
  }

  private screen(name: string): FakeScreenDef {
    const found = this.options.screens.find((s) => s.name === name);
    if (!found) throw new Error(`FakeMainframe: no screen named "${name}"`);
    return found;
  }

  private arrive(): void {
    this.values = {};
    const first = this.current.fields?.[0];
    this.cursor = first ? { row: first.row - 1, col: first.col - 1 } : { row: 0, col: 0 };
  }

  private locked(): boolean {
    return Date.now() < this.lockedUntil;
  }

  /** Applies a screen change once the host has "answered". */
  private tick(): void {
    if (this.pending !== undefined && !this.locked()) {
      this.current = this.screen(this.pending);
      this.pending = undefined;
      this.arrive();
    }
  }

  private fieldAt(row: number, col: number): FakeField | undefined {
    return this.current.fields?.find(
      (f) => f.row - 1 === row && col >= f.col - 1 && col < f.col - 1 + f.length,
    );
  }

  private render(): string[] {
    const rows = Array.from({ length: ROWS }, (_, i) =>
      (this.current.lines[i] ?? '').padEnd(COLS, ' ').slice(0, COLS),
    );
    for (const f of this.current.fields ?? []) {
      const shown = f.hidden ? '' : (this.values[f.name] ?? '');
      const r = rows[f.row - 1] ?? ''.padEnd(COLS, ' ');
      rows[f.row - 1] =
        r.slice(0, f.col - 1) +
        shown.padEnd(f.length, ' ').slice(0, f.length) +
        r.slice(f.col - 1 + f.length);
    }
    return rows;
  }

  private status(): string {
    const kbd = this.locked() ? 'L' : 'U';
    const conn = this.connected ? `C(${this.host})` : 'N';
    return `${kbd} ${this.current.fields?.length ? 'F' : 'U'} U ${conn} I 4 ${ROWS} ${COLS} ${this.cursor.row} ${this.cursor.col} 0x0 -`;
  }

  private reply(data: string[] = []): Tn3270Reply {
    return { data, status: parseStatusLine(this.status()) };
  }

  private aid(next: string | undefined): void {
    this.lockedUntil = Date.now() + (this.options.unlockDelayMs ?? 0);
    this.pending = next ?? this.current.name; // staying on the same screen still refreshes it
  }

  async request(command: string): Promise<Tn3270Reply> {
    this.commands.push(command);
    this.tick();
    const match = /^(\w+)(?:\((.*)\))?$/s.exec(command.trim());
    if (!match) throw new Tn3270Error(`unknown command: ${command}`);
    const name = (match[1] as string).toLowerCase();
    const args = splitArgs(match[2] ?? '');

    if (name === 'quit' || name === 'disconnect') {
      this.connected = false;
      return this.reply();
    }
    if (name === 'connect') {
      if (!args[0]) throw new Tn3270Error('Connect: host is required');
      this.connected = true;
      this.host = args[0].replace(/^L:/, '').replace(/:\d+$/, ''); // s3270 reports the host name only
      return this.reply();
    }
    if (!this.connected) throw new Tn3270Error('not connected');

    switch (name) {
      case 'wait': {
        const seconds = args.length > 1 ? Number(args[0]) : 30;
        const remaining = this.lockedUntil - Date.now();
        if (remaining > seconds * 1000) throw new Tn3270Error('Wait: Timed out');
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        this.tick();
        return this.reply();
      }
      case 'ascii': {
        const rows = this.render();
        if (args.length >= 4) {
          const [r, c, h, w] = args.map(Number) as [number, number, number, number];
          return this.reply(rows.slice(r, r + h).map((line) => line.slice(c, c + w)));
        }
        return this.reply(rows);
      }
      case 'string': {
        if (this.locked()) throw new Tn3270Error('Keyboard locked');
        const text = unquote(args[0] ?? '');
        for (const ch of text) {
          const field = this.fieldAt(this.cursor.row, this.cursor.col);
          if (!field) throw new Tn3270Error('Keyboard locked: the cursor is not in an input field');
          const offset = this.cursor.col - (field.col - 1);
          const old = (this.values[field.name] ?? '').padEnd(field.length, ' ');
          this.values[field.name] = (old.slice(0, offset) + ch + old.slice(offset + 1))
            .slice(0, field.length)
            .trimEnd();
          if (offset < field.length - 1) this.cursor.col++;
        }
        return this.reply();
      }
      case 'moveCursor'.toLowerCase():
        this.cursor = { row: Number(args[0]), col: Number(args[1]) };
        return this.reply();
      case 'tab': {
        const fields = [...(this.current.fields ?? [])].sort(
          (a, b) => a.row - b.row || a.col - b.col,
        );
        const here = this.cursor.row * COLS + this.cursor.col;
        const next = fields.find((f) => (f.row - 1) * COLS + (f.col - 1) > here) ?? fields[0];
        if (next) this.cursor = { row: next.row - 1, col: next.col - 1 };
        return this.reply();
      }
      case 'home': {
        const first = this.current.fields?.[0];
        this.cursor = first ? { row: first.row - 1, col: first.col - 1 } : { row: 0, col: 0 };
        return this.reply();
      }
      case 'eraseeof': {
        const field = this.fieldAt(this.cursor.row, this.cursor.col);
        if (field) {
          const keep = this.cursor.col - (field.col - 1);
          this.values[field.name] = (this.values[field.name] ?? '').slice(0, keep).trimEnd();
        }
        return this.reply();
      }
      case 'clear':
        this.values = {};
        this.aid(this.current.name);
        return this.reply();
      case 'enter':
        if (this.locked()) throw new Tn3270Error('Keyboard locked');
        this.aid(this.current.onEnter?.({ ...this.values }));
        return this.reply();
      case 'pf':
      case 'pa': {
        if (this.locked()) throw new Tn3270Error('Keyboard locked');
        const handler = this.current.onPF?.[Number(args[0])];
        this.aid(name === 'pf' ? handler?.({ ...this.values }) : undefined);
        return this.reply();
      }
      default:
        throw new Tn3270Error(`unknown command: ${command}`);
    }
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

function parseStatusLine(raw: string) {
  // local copy of types.parseStatus to keep this file free of cycles
  const f = raw.split(' ');
  return {
    keyboard: (f[0] === 'U' ? 'unlocked' : 'locked') as 'unlocked' | 'locked',
    formatted: f[1] === 'F',
    connected: (f[3] ?? '').startsWith('C('),
    host: (f[3] ?? '').startsWith('C(') ? (f[3] as string).slice(2, -1) : undefined,
    rows: Number(f[6]),
    cols: Number(f[7]),
    cursorRow: Number(f[8]),
    cursorCol: Number(f[9]),
    raw,
  };
}

/** Splits `a,"b,c",d` on top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\\' && depth) {
      cur += ch + (text[++i] ?? '');
      continue;
    }
    if (ch === '"') depth = !depth;
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

function unquote(arg: string): string {
  const inner = arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
  return inner.replace(/\\(.)/g, '$1');
}

export interface SampleMainframeOptions {
  user?: string;
  password?: string;
  accounts?: Record<string, { name: string; balance: string }>;
  unlockDelayMs?: number;
}

/**
 * A made-up TSO/CICS-style application: logon -> main menu (account number) -> account inquiry, with
 * PF3 to go back and an error line for a wrong password or an unknown account.
 */
export function createSampleMainframe(options: SampleMainframeOptions = {}): FakeMainframe {
  const { user = 'TESTUSER', password = 'correct-horse', unlockDelayMs = 150 } = options;
  const accounts = options.accounts ?? {
    '123456': { name: 'ADA LOVELACE', balance: '1,234.56 GBP' },
    '654321': { name: 'GRACE HOPPER', balance: '99.00 GBP' },
  };
  const logon = (message = ''): FakeScreenDef => ({
    name: message ? 'logonFailed' : 'logon',
    lines: [
      '',
      '   WELCOME TO THE TEST MAINFRAME',
      '',
      '   USERID   ===> ',
      '   PASSWORD ===> ',
      ...Array(16).fill(''),
      `   ${message}`,
    ],
    fields: [
      { name: 'userid', row: 4, col: 18, length: 8 },
      { name: 'password', row: 5, col: 18, length: 16, hidden: true },
    ],
    onEnter: (v) => (v.userid === user && v.password === password ? 'menu' : 'logonFailed'),
  });
  const menu = (message = ''): FakeScreenDef => ({
    name: message ? 'menuNotFound' : 'menu',
    lines: [
      '',
      '   MAIN MENU',
      '',
      '   ACCOUNT NUMBER ===> ',
      '',
      '   1 - ACCOUNT INQUIRY',
      ...Array(16).fill(''),
      `   ${message}`,
      '   PF3=LOGOFF',
    ],
    fields: [{ name: 'acct', row: 4, col: 26, length: 6 }],
    onEnter: (v) => (v.acct && accounts[v.acct] ? `account:${v.acct}` : 'menuNotFound'),
    onPF: { 3: () => 'logon' },
  });
  return new FakeMainframe({
    start: 'logon',
    unlockDelayMs,
    screens: [
      logon(),
      logon('INVALID USERID OR PASSWORD'),
      menu(),
      menu('ACCOUNT NOT FOUND'),
      ...Object.entries(accounts).map(([number, a]): FakeScreenDef => ({
        name: `account:${number}`,
        lines: [
          '',
          `   ACCOUNT ${number}`,
          '',
          `   NAME     ${a.name}`,
          `   BALANCE  ${a.balance}`,
          ...Array(18).fill(''),
          '   PF3=BACK',
        ],
        onPF: { 3: () => 'menu' },
      })),
    ],
  });
}
