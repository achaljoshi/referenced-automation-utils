import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { SqliteClient } from '../db/sqliteClient';
import { RemoteConfig, type RemoteConfigValues } from '../remote/config';
import {
  AGENT_VERSION,
  CAPABILITY_FOR_TYPE,
  DEFAULT_MAX_ROWS,
  MAX_EXEC_OUTPUT,
  MAX_REQUEST_AGE_MS,
  PROTOCOL_VERSION,
  remotePaths,
  type RemoteHeartbeat,
  type RemoteProcSendRequest,
  type RemoteProcStartRequest,
  type RemoteRequest,
  type RemoteRequestType,
  type RemoteResponse,
  type RemoteDbRequest,
  type RemoteExecRequest,
  type RemoteHttpRequest,
  type RemotePaths,
} from '../remote/protocol';

/**
 * The PowerShell agent's job done in Node, over the same folder layout and wire contract, so everything on the client
 * side can be tested on any machine: ping, http (fetch), db (SqliteClient: the provider/connection string pick a
 * database, `:memory:` is shared by this agent), exec (child_process), proc (a node child that speaks lines),
 * allow-list checks, heartbeat, stale-request cleanup, config reload, shutdown. Like the real agent it handles ONE
 * request at a time, in the order they arrived.
 *
 * Fault injection: `hold` (never answers those request types), `crash()` (stops without removing the heartbeat, as a
 * killed session would), `pauseHeartbeat()`.
 */
export interface StandInOptions {
  shareDir: string;
  pollMs?: number;
  heartbeatMs?: number;
  /** Used until the client writes agent/config.json. */
  allow?: string[];
  maxRequestAgeMs?: number;
  hold?: RemoteRequestType[];
  agentVersion?: string;
  interactive?: boolean;
}

interface HandlerError {
  code: 'DENIED' | 'BAD_REQUEST' | 'TIMEOUT' | 'REMOTE_ERROR' | 'NOT_FOUND';
  message: string;
}

function fail(code: HandlerError['code'], message: string): never {
  throw { code, message } satisfies HandlerError;
}

interface ProcState {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  waiters: Array<(line: string | null) => void>;
  exited: boolean;
  tempFile?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StandInAgent {
  readonly paths: RemotePaths;
  /** Request types in the order they were processed (answered or not). */
  readonly processed: RemoteRequestType[] = [];
  readonly correlationIds: Array<string | undefined> = [];
  shutdownLogoff: boolean | undefined;
  allow: string[];
  private running = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private loop?: Promise<void>;
  private configStamp = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly databases = new Map<string, SqliteClient>();
  private readonly procs = new Map<string, ProcState>();
  private readonly pollMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly options: StandInOptions) {
    this.paths = remotePaths(options.shareDir);
    this.allow = options.allow ?? ['http', 'db', 'sap'];
    this.pollMs = options.pollMs ?? 20;
    this.heartbeatMs = options.heartbeatMs ?? 50;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    for (const dir of [this.paths.requests, this.paths.responses, this.paths.agent]) fs.mkdirSync(dir, { recursive: true });
    this.running = true;
    this.reloadConfig();
    this.writeHeartbeat();
    this.resumeHeartbeat();
    this.loop = this.run();
  }

  /** A clean exit, like the real agent's: the heartbeat file is removed. */
  async stop(): Promise<void> {
    this.running = false;
    this.pauseHeartbeat();
    await this.loop;
    for (const id of [...this.procs.keys()]) this.stopProc(id);
    for (const db of this.databases.values()) await db.close();
    this.databases.clear();
    fs.rmSync(this.paths.heartbeat, { force: true });
  }

  /** Dies without cleaning up: the heartbeat file stays and simply stops being refreshed. */
  async crash(): Promise<void> {
    this.running = false;
    this.pauseHeartbeat();
    await this.loop;
    for (const id of [...this.procs.keys()]) this.stopProc(id);
  }

  pauseHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  resumeHeartbeat(): void {
    this.pauseHeartbeat();
    this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), this.heartbeatMs);
  }

  private writeHeartbeat(): void {
    const heartbeat: RemoteHeartbeat = {
      agentVersion: this.options.agentVersion ?? AGENT_VERSION,
      pid: process.pid,
      host: 'STAND-IN-HOST',
      user: 'STANDIN\\tester',
      sessionId: 2,
      interactive: this.options.interactive ?? true,
      psVersion: '5.1.stand-in',
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      allow: this.allow,
    };
    const tmp = `${this.paths.heartbeat}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(heartbeat));
    fs.renameSync(tmp, this.paths.heartbeat);
  }

  private reloadConfig(): void {
    try {
      const stat = fs.statSync(this.paths.config);
      if (stat.mtimeMs === this.configStamp) return;
      const config = JSON.parse(fs.readFileSync(this.paths.config, 'utf8')) as { allow?: string[] };
      if (Array.isArray(config.allow)) this.allow = config.allow.map((a) => String(a).toLowerCase());
      this.configStamp = stat.mtimeMs;
    } catch {
      // no config yet, or half-written: keep what we have
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.reloadConfig();
      const names = fs
        .readdirSync(this.paths.requests)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ n, t: fs.statSync(path.join(this.paths.requests, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
        .sort((a, b) => a.t - b.t || a.n.localeCompare(b.n));
      for (const { n } of names) {
        if (!this.running) break;
        await this.handleFile(path.join(this.paths.requests, n));
      }
      await sleep(this.pollMs);
    }
  }

  private async handleFile(file: string): Promise<void> {
    const id = path.basename(file, '.json');
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > (this.options.maxRequestAgeMs ?? MAX_REQUEST_AGE_MS)) {
        fs.rmSync(file, { force: true }); // too old: the client has given up long ago
        return;
      }
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // the client withdrew it
    }
    const started = Date.now();
    let request: RemoteRequest | undefined;
    let response: RemoteResponse;
    try {
      request = JSON.parse(text) as RemoteRequest;
      if (request.v !== PROTOCOL_VERSION) fail('BAD_REQUEST', 'unsupported protocol version');
      if (!(request.type in CAPABILITY_FOR_TYPE)) fail('BAD_REQUEST', `unknown request type "${String(request.type)}"`);
      this.processed.push(request.type);
      this.correlationIds.push(request.correlationId);
      if (this.options.hold?.includes(request.type)) return; // fault injection: never answered
      const needed = CAPABILITY_FOR_TYPE[request.type];
      if (needed && !this.allow.includes(needed)) fail('DENIED', `"${request.type}" is not allowed by REMOTE_ALLOW (allowed: ${this.allow.join(', ')})`);
      const result = await this.dispatch(request);
      response = { v: PROTOCOL_VERSION, id, ok: true, result, durationMs: Date.now() - started };
    } catch (error) {
      const e = error as Partial<HandlerError> & Error;
      response = {
        v: PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code: e.code ?? 'REMOTE_ERROR', message: e.message ?? String(error) },
        durationMs: Date.now() - started,
      };
    }
    const target = path.join(this.paths.responses, `${id}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(response));
    fs.renameSync(`${target}.tmp`, target);
    fs.rmSync(file, { force: true });
    if (request?.type === 'shutdown') {
      this.shutdownLogoff = Boolean((request.payload as { logoff?: boolean } | undefined)?.logoff);
      void this.stop();
    }
  }

  private async dispatch(request: RemoteRequest): Promise<unknown> {
    switch (request.type) {
      case 'ping':
        return {
          host: 'STAND-IN-HOST',
          user: 'STANDIN\\tester',
          sessionId: 2,
          interactive: this.options.interactive ?? true,
          psVersion: '5.1.stand-in',
          agentVersion: this.options.agentVersion ?? AGENT_VERSION,
          pid: process.pid,
        };
      case 'http':
        return this.http(request.payload as RemoteHttpRequest);
      case 'db.query':
      case 'db.update':
        return this.db(request.payload as RemoteDbRequest, request.type === 'db.update');
      case 'exec':
        return this.exec(request.payload as RemoteExecRequest);
      case 'proc.start':
        return this.procStart(request.payload as RemoteProcStartRequest);
      case 'proc.send':
        return this.procSend(request.payload as RemoteProcSendRequest);
      case 'proc.stop':
        return this.procStop(request.payload as { id: string });
      case 'shutdown':
        return { stopping: true };
    }
  }

  // ---------------------------------------------------------------------------------------------- handlers

  private async http(p: RemoteHttpRequest): Promise<unknown> {
    if (!p.url) fail('BAD_REQUEST', 'http needs a url');
    const started = Date.now();
    const timeoutMs = p.timeoutMs ?? 30_000;
    try {
      const response = await fetch(p.url, {
        method: p.method,
        headers: p.headers,
        body: p.bodyBase64 ? Buffer.from(p.bodyBase64, 'base64') : undefined,
        redirect: p.followRedirects ? 'follow' : 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => (headers[key] = value));
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
        url: response.url || p.url,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') fail('TIMEOUT', `the http request did not finish within ${timeoutMs} ms`);
      fail('REMOTE_ERROR', `${(error as Error).message}${(error as { cause?: Error }).cause ? ` -> ${(error as { cause: Error }).cause.message}` : ''}`);
    }
  }

  private async db(p: RemoteDbRequest, isUpdate: boolean): Promise<unknown> {
    if (!p.provider || !p.connectionString || !p.sql) fail('BAD_REQUEST', 'a db request needs provider, connectionString and sql');
    // "Data Source=<file or :memory:>;..." (like a .NET connection string) or the bare file name / :memory:
    const database = /Data Source=([^;]+)/i.exec(p.connectionString)?.[1] ?? p.connectionString;
    let client = this.databases.get(database);
    if (!client) {
      client = new SqliteClient(database);
      this.databases.set(database, client);
    }
    try {
      if (isUpdate) return { rows: [], rowCount: await client.update(p.sql, p.params ?? []) };
      const all = await client.query<Record<string, unknown>>(p.sql, p.params ?? []);
      const max = p.maxRows ?? DEFAULT_MAX_ROWS;
      const rows = all.slice(0, max).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'bigint' ? v.toString() : v]),
        ),
      );
      return { rows, rowCount: rows.length, truncated: all.length > max };
    } catch (error) {
      fail('REMOTE_ERROR', (error as Error).message);
    }
  }

  private exec(p: RemoteExecRequest): Promise<unknown> {
    if (!p.command) fail('BAD_REQUEST', 'exec needs a command');
    const timeoutMs = p.timeoutMs ?? 60_000;
    const line = [p.command, ...(p.args ?? [])].join(' ');
    // `cmd` / `powershell` have no counterpart here: both run the command line through /bin/sh.
    const child = p.shell ? spawn('/bin/sh', ['-c', line], { cwd: p.cwd, env: { ...process.env, ...p.env } }) : spawn(p.command, p.args ?? [], { cwd: p.cwd, env: { ...process.env, ...p.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.stdin.end();
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject({ code: 'REMOTE_ERROR', message: `could not start the command: ${error.message}` } satisfies HandlerError);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: timedOut ? -1 : (code ?? -1), stdout: stdout.slice(0, MAX_EXEC_OUTPUT), stderr: stderr.slice(0, MAX_EXEC_OUTPUT), timedOut });
      });
    });
  }

  private procStart(p: RemoteProcStartRequest): unknown {
    if (!p.id || !/^[A-Za-z0-9_-]{1,64}$/.test(p.id)) fail('BAD_REQUEST', 'proc.start needs an id of letters, digits, - and _');
    if (this.procs.has(p.id)) fail('BAD_REQUEST', `a process with id ${p.id} already exists`);
    if ((p.scriptText === undefined) === (p.file === undefined)) fail('BAD_REQUEST', 'proc.start needs exactly one of scriptText or file');
    let target = p.file as string;
    let tempFile: string | undefined;
    if (p.scriptText !== undefined) {
      tempFile = path.join(os.tmpdir(), `stand-in-proc-${p.id}-${Date.now()}.js`);
      fs.writeFileSync(tempFile, p.scriptText);
      target = tempFile;
    } else if (!fs.existsSync(target)) fail('NOT_FOUND', `script file not found on this host: ${target}`);
    const child = spawn(process.execPath, [target, ...(p.args ?? [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    const state: ProcState = { child, lines: [], waiters: [], exited: false, tempFile };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const waiter = state.waiters.shift();
      if (waiter) waiter(line);
      else state.lines.push(line);
    });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('exit', () => {
      state.exited = true;
      for (const waiter of state.waiters.splice(0)) waiter(null);
    });
    this.procs.set(p.id, state);
    return { id: p.id, pid: child.pid };
  }

  private async procSend(p: RemoteProcSendRequest): Promise<unknown> {
    const state = this.procs.get(p.id);
    if (!state) fail('NOT_FOUND', `no process with id ${p.id}`);
    if (/[\r\n]/.test(p.line)) fail('BAD_REQUEST', 'a line must not contain line breaks');
    state.child.stdin.write(`${p.line}\n`);
    const answer = await new Promise<string | null | undefined>((resolve) => {
      const queued = state.lines.shift();
      if (queued !== undefined) return resolve(queued);
      const timer = setTimeout(() => {
        state.waiters.splice(state.waiters.indexOf(waiter), 1);
        resolve(undefined);
      }, p.timeoutMs);
      const waiter = (line: string | null) => {
        clearTimeout(timer);
        resolve(line);
      };
      state.waiters.push(waiter);
    });
    if (answer === undefined) {
      this.stopProc(p.id);
      fail('TIMEOUT', `no answer line within ${p.timeoutMs} ms; the process was stopped, because a late answer would be taken for the next one`);
    }
    if (answer === null) {
      this.stopProc(p.id);
      fail('REMOTE_ERROR', 'the process ended without answering');
    }
    return { line: answer };
  }

  private procStop(p: { id: string }): unknown {
    if (!this.procs.has(p.id)) fail('NOT_FOUND', `no process with id ${p.id}`);
    this.stopProc(p.id);
    return { stopped: true, exitCode: 0 };
  }

  private stopProc(id: string): void {
    const state = this.procs.get(id);
    if (!state) return;
    this.procs.delete(id);
    state.child.kill('SIGKILL');
    if (state.tempFile) fs.rmSync(state.tempFile, { force: true });
  }
}

/** A manual-start RemoteConfig with fast timings for tests against the stand-in agent (it beats every 50 ms; "stale" is 1 s). */
export function standInRemoteConfig(shareDir: string, overrides: Partial<RemoteConfigValues> = {}): RemoteConfig {
  return RemoteConfig.create({
    host: 'rdp-host.test',
    agentStart: 'manual',
    shareDir,
    pollMs: 20,
    heartbeatMs: 100,
    heartbeatStaleMs: 1000,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    ...overrides,
  });
}
