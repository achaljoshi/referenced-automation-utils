import * as net from 'node:net';

export interface ImapTestMessage {
  from?: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  /** When it "arrived" (the IMAP internal date). Default: now. */
  date?: Date;
}

export interface ImapTestServerHandle {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Delivers a message to the INBOX (unseen) and returns its UID. */
  addMessage(message: ImapTestMessage): number;
  /** The subjects of the messages still unseen, in UID order. */
  unseenSubjects(): string[];
  /** Whether a message has been marked \Seen. */
  isSeen(uid: number): boolean;
  /** Abruptly closes every open client connection (the server keeps listening). */
  dropConnections(): void;
  stop(): Promise<void>;
}

interface Stored extends ImapTestMessage {
  uid: number;
  raw: string;
  flags: Set<string>;
  date: Date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const imapDate = (d: Date) =>
  `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function addressList(address: string | undefined): string {
  if (!address) return 'NIL';
  const [mailbox = '', host = ''] = address.split('@');
  return `((NIL NIL ${quote(mailbox)} ${quote(host)}))`;
}

function envelope(m: Stored): string {
  return `(${quote(m.date.toUTCString())} ${quote(m.subject)} ${addressList(m.from)} ${addressList(m.from)} ${addressList(m.from)} ${addressList(m.to)} ${addressList(m.cc)} NIL NIL NIL ${quote(`<${m.uid}@imap.test>`)})`;
}

/** "1,3:5,7:*" as a predicate over a number, with `max` standing in for `*`. */
function inSet(set: string, max: number): (n: number) => boolean {
  const ranges = set.split(',').map((part) => {
    const [a = '', b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * A small, real, in-process IMAP server (one INBOX) for testing anything that reads mail - `findEmailBySubject`, or an
 * application under test. It speaks just enough IMAP4rev1 for ImapFlow: LOGIN, SELECT, UID SEARCH (UNSEEN), UID FETCH
 * (envelope, internal date, flags, body), UID STORE flags, LOGOUT. Like the SMTP test server it needs fixed
 * credentials, so tests also prove they are sent. Plain-text only (no TLS): connect with `secure: false`.
 */
export async function startImapTestServer(): Promise<ImapTestServerHandle> {
  const username = 'testuser';
  const password = 'testpass';
  const messages: Stored[] = [];
  const sockets = new Set<net.Socket>();
  let nextUid = 1;

  const flagsOf = (m: Stored) => `(${[...m.flags].join(' ')})`;

  function handle(socket: net.Socket, line: string, state: { authed: boolean; selected: boolean }): void {
    const send = (text: string): void => void socket.write(`${text}\r\n`);
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) return send('* BAD could not parse the command');
    const [, tag = '*', rawCommand = '', rest = ''] = match;
    const command = rawCommand.toUpperCase();
    const ok = (text = 'completed') => send(`${tag} OK ${text}`);
    const uidMode = command === 'UID';
    const [effective, args] = uidMode
      ? ((/^(\S+)\s*(.*)$/.exec(rest) ?? []).slice(1) as [string, string])
      : [command, rest];
    const verb = (effective ?? '').toUpperCase();

    if (command === 'CAPABILITY') {
      send('* CAPABILITY IMAP4rev1 UIDPLUS');
      return ok();
    }
    if (command === 'NOOP') return ok();
    if (command === 'LOGIN') {
      const [user, pass] = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'));
      if (user === username && pass === password) {
        state.authed = true;
        return ok('LOGIN completed');
      }
      return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    }
    if (!state.authed) return send(`${tag} NO not authenticated`);

    if (command === 'LOGOUT') {
      send('* BYE logging out');
      ok('LOGOUT completed');
      return void socket.end();
    }
    if (command === 'SELECT' || command === 'EXAMINE') {
      state.selected = true;
      send(`* ${messages.length} EXISTS`);
      send('* 0 RECENT');
      send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
      send('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] flags');
      send('* OK [UIDVALIDITY 1] UIDs valid');
      send(`* OK [UIDNEXT ${nextUid}] predicted next UID`);
      return send(`${tag} OK [READ-WRITE] SELECT completed`);
    }
    if (command === 'CLOSE' || command === 'UNSELECT') {
      state.selected = false;
      return ok();
    }
    if (command === 'LIST') {
      send('* LIST (\\HasNoChildren) "/" "INBOX"');
      return ok();
    }
    if (command === 'NAMESPACE') {
      send('* NAMESPACE (("" "/")) NIL NIL');
      return ok();
    }
    if (!state.selected) return send(`${tag} NO select a mailbox first`);

    const max = messages.reduce((m, x) => Math.max(m, uidMode ? x.uid : messages.indexOf(x) + 1), 0);
    const seqOf = (m: Stored) => messages.indexOf(m) + 1;

    if (verb === 'SEARCH') {
      const wantUnseen = /\bUNSEEN\b/i.test(args ?? '');
      const found = messages.filter((m) => !wantUnseen || !m.flags.has('\\Seen')).map((m) => (uidMode ? m.uid : seqOf(m)));
      send(`* SEARCH${found.length ? ` ${found.join(' ')}` : ''}`);
      return ok('SEARCH completed');
    }
    if (verb === 'FETCH') {
      const [set = '', items = ''] = /^(\S+)\s+(.*)$/.exec(args ?? '')?.slice(1) ?? [];
      const wanted = items.toUpperCase();
      const pick = inSet(set, max);
      for (const m of messages) {
        if (!pick(uidMode ? m.uid : seqOf(m))) continue;
        const parts: string[] = [`UID ${m.uid}`];
        if (wanted.includes('ENVELOPE')) parts.push(`ENVELOPE ${envelope(m)}`);
        if (wanted.includes('INTERNALDATE')) parts.push(`INTERNALDATE "${imapDate(m.date)}"`);
        if (wanted.includes('FLAGS')) parts.push(`FLAGS ${flagsOf(m)}`);
        if (wanted.includes('BODY.PEEK[]') || wanted.includes('BODY[]') || wanted.includes('RFC822')) {
          parts.push(`BODY[] {${Buffer.byteLength(m.raw)}}\r\n${m.raw}`);
        }
        send(`* ${seqOf(m)} FETCH (${parts.join(' ')})`);
      }
      return ok('FETCH completed');
    }
    if (verb === 'STORE') {
      const [set = '', mode = '', flagText = ''] = /^(\S+)\s+(\S+)\s+\(?([^)]*)\)?$/.exec(args ?? '')?.slice(1) ?? [];
      const flags = flagText.split(/\s+/).filter(Boolean);
      const pick = inSet(set, max);
      for (const m of messages) {
        if (!pick(uidMode ? m.uid : seqOf(m))) continue;
        if (mode.startsWith('+FLAGS')) for (const f of flags) m.flags.add(f);
        else if (mode.startsWith('-FLAGS')) for (const f of flags) m.flags.delete(f);
        else m.flags = new Set(flags);
        if (!mode.includes('SILENT')) send(`* ${seqOf(m)} FETCH (UID ${m.uid} FLAGS ${flagsOf(m)})`);
      }
      return ok('STORE completed');
    }
    return send(`${tag} BAD unsupported command ${rawCommand}`);
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const state = { authed: false, selected: false };
    let buffer = '';
    socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] test IMAP server ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (line) handle(socket, line, state);
      }
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    host: '127.0.0.1',
    port,
    username,
    password,
    addMessage(message) {
      const uid = nextUid++;
      const date = message.date ?? new Date();
      const from = message.from ?? 'sender@example.com';
      const raw = [
        `From: ${from}`,
        `To: ${message.to}`,
        ...(message.cc ? [`Cc: ${message.cc}`] : []),
        `Subject: ${message.subject}`,
        `Date: ${date.toUTCString()}`,
        `Message-ID: <${uid}@imap.test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        message.text,
        '',
      ].join('\r\n');
      messages.push({ ...message, from, uid, raw, date, flags: new Set() });
      return uid;
    },
    unseenSubjects: () => messages.filter((m) => !m.flags.has('\\Seen')).map((m) => m.subject),
    isSeen: (uid) => messages.find((m) => m.uid === uid)?.flags.has('\\Seen') ?? false,
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function stopImapTestServer(handle: ImapTestServerHandle): Promise<void> {
  return handle.stop();
}
