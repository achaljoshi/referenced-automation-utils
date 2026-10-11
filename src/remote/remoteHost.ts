import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { adapterStep, type Adapter } from '../adapters/adapter';
import { loadEnv, type ConfigReader } from '../config/env';
import { getCorrelationId } from '../logger/correlation';
import { getLogger } from '../logger/logger';
import { remoteConfigFromEnv, type RemoteCapability, type RemoteConfig } from './config';
import { RemoteError, type RemoteErrorCode } from './errors';
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureMailbox,
  heartbeatAgeMs,
  heartbeatIsFresh,
  installAgentFiles,
  otherLiveClients,
  parseJsonText,
  purgeMailbox,
  readHeartbeat,
  registerClient,
  releaseStartLock,
  removeQuietly,
  sleep,
  tailOfFile,
  tryAcquireStartLock,
  type HeartbeatReading,
} from './mailbox';
import {
  AGENT_VERSION,
  PROTOCOL_VERSION,
  remotePaths,
  type RemoteAgentConfigFile,
  type RemoteDbResult,
  type RemoteExecRequest,
  type RemoteExecResult,
  type RemoteHttpRequest,
  type RemoteHttpResponse,
  type RemotePingResult,
  type RemoteProcSendResult,
  type RemoteRequest,
  type RemoteRequestType,
  type RemoteResponse,
  type RemotePaths,
} from './protocol';
import { checkRdpPrerequisites, RdpSession, type CommandRunner } from './rdp';
import { setupHelp } from './setupHelp';

export { RemoteError, type RemoteErrorCode } from './errors';

export interface RemoteHostOptions {
  /** Replaces the real mstsc / cmdkey / subst calls (tests). */
  runner?: CommandRunner;
  /** Where remote-agent.ps1 and start.cmd are copied from. Default: the `agent/` folder of this package. */
  agentSourceDir?: string;
  /** Where the temporary .rdp file is written. Default: the OS temp dir. */
  rdpTempDir?: string;
}

export interface DiagnoseStage {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when `ok` is false (empty when it is true). */
  hint: string;
}

export interface DiagnoseOptions {
  /** Also run an HTTP GET to this URL from the host. */
  url?: string;
  /** Also run `SELECT 1` through REMOTE_DB_PROVIDER / REMOTE_DB_CONNECTION_STRING. */
  db?: boolean;
  /** Also run `hostname` on the host (needs `exec` in REMOTE_ALLOW). */
  exec?: boolean;
}

export interface DbCallOptions {
  provider?: string;
  connectionString?: string;
  maxRows?: number;
  timeoutMs?: number;
}

/** Added to what the agent is told to wait, so the agent's own timeout answers before the client gives up. */
const CLIENT_MARGIN_MS = 10_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

const WIRE_TO_ERROR: Record<string, RemoteErrorCode> = { DENIED: 'DENIED', TIMEOUT: 'TIMEOUT' };

function newRequestId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/** A helper process on the host that speaks a line protocol (started with `RemoteHost.startProcess`). */
export class RemoteProcess {
  private stopped = false;

  constructor(
    readonly id: string,
    private readonly host: RemoteHost,
  ) {}

  /** Sends one line and returns the next line the process prints. A timeout stops the process (see protocol.ts). */
  async send(line: string, timeoutMs: number = this.host.config.requestTimeoutMs): Promise<string> {
    if (/[\r\n]/.test(line))
      throw new RemoteError('REMOTE_ERROR', 'a line sent to a remote process must not contain line breaks', { operation: 'proc.send' });
    const result = await this.host.request<RemoteProcSendResult>('proc.send', { id: this.id, line, timeoutMs }, { timeoutMs: timeoutMs + CLIENT_MARGIN_MS });
    return result.line;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.host.forget(this);
    try {
      await this.host.request('proc.stop', { id: this.id });
    } catch (error) {
      // Already gone (stopped after a timeout, or the agent shut down): nothing left to stop.
      if (!(error instanceof RemoteError && error.remoteCode === 'NOT_FOUND')) throw error;
    }
  }
}

/**
 * Runs DB, API, SAP and other steps on a remote Windows desktop host that the test machine (for example an AWS
 * WorkSpace) can reach only by Remote Desktop. Requests travel as files through one redirected drive (the "RDP drive
 * mailbox", see protocol.ts) to a PowerShell agent that runs inside the logged-in RDP session; no other port is
 * needed. See docs/REMOTE_DESKTOP.md and ADR 0012.
 *
 * ```ts
 * const host = await getRemoteHost();            // undefined unless REMOTE_ENABLED=true -> use the local services
 * const reply = await host?.http({ method: 'GET', url: 'https://internal-api/health' });
 * const rows = await host?.dbQuery('SELECT TOP 1 * FROM orders WHERE id = @p0', [42]);
 * ```
 *
 * Not verified on a real Windows host: see the header of rdp.ts and agent/remote-agent.ps1.
 */
export class RemoteHost implements Adapter {
  readonly name = 'remote';
  readonly paths: RemotePaths;
  private readonly log = getLogger('remote');
  private connectPromise?: Promise<void>;
  private connected = false;
  private rdp?: RdpSession;
  private clientFile?: string;
  private readonly processes = new Set<RemoteProcess>();

  constructor(
    readonly config: RemoteConfig,
    private readonly options: RemoteHostOptions = {},
  ) {
    this.paths = remotePaths(config.shareDir);
  }

  /** `undefined` unless REMOTE_ENABLED=true: the caller then uses its local services. */
  static fromEnv(env?: ConfigReader, options?: RemoteHostOptions): RemoteHost | undefined {
    const config = remoteConfigFromEnv(env);
    return config ? new RemoteHost(config, options) : undefined;
  }

  // ------------------------------------------------------------------------------------------------ connecting

  /**
   * Makes sure an agent is answering: creates the mailbox, copies the agent files (overwriting an older version),
   * writes its config, and then either reuses a session that is already running or starts one according to
   * REMOTE_AGENT_START. Safe to call again and from several processes at once.
   */
  connect(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = adapterStep(this.name, 'connect', () => this.doConnect(), {
        details: { host: this.config.host, port: this.config.port, start: this.config.agentStart },
      }).then(
        () => {
          this.connected = true;
        },
        (error: unknown) => {
          this.connectPromise = undefined;
          throw error;
        },
      );
    }
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    const { config, paths } = this;
    ensureMailbox(paths);
    const installed = installAgentFiles(paths, this.options.agentSourceDir);
    if (installed.written.length > 0) this.log.info(`agent files written to ${paths.agent}: ${installed.written.join(', ')} (agent version ${AGENT_VERSION})`);
    if (config.allow.includes('exec'))
      this.log.warn('REMOTE_ALLOW includes "exec": any step can run arbitrary commands on the remote host as the logged-in user');
    this.writeAgentConfig();
    this.clientFile = registerClient(paths);
    try {
      const running = readHeartbeat(paths);
      if (heartbeatIsFresh(running, config.heartbeatStaleMs)) {
        await this.reuse(running);
        return;
      }
      const purged = purgeMailbox(paths);
      if (purged > 0) this.log.info(`removed ${purged} leftover request/response file(s) of an earlier run`);
      if (config.agentStart === 'alternate-shell') await this.startViaRdp();
      else await this.waitForUserStartedAgent();
    } catch (error) {
      this.unregister();
      throw error;
    }
  }

  private writeAgentConfig(): void {
    const file: RemoteAgentConfigFile = { allow: this.config.allow, pollMs: this.config.pollMs, heartbeatMs: this.config.heartbeatMs };
    atomicWriteJson(this.paths.config, file);
  }

  private async reuse(running: HeartbeatReading): Promise<void> {
    const { heartbeat } = running;
    this.log.info(`reusing the running agent (pid ${heartbeat.pid}, ${heartbeat.user}@${heartbeat.host}, session ${heartbeat.sessionId})`);
    if (heartbeat.agentVersion !== AGENT_VERSION)
      this.log.warn(
        `the running agent is version ${heartbeat.agentVersion} but this package carries ${AGENT_VERSION}; it keeps running the old script until the session is restarted (automation-remote close, then connect again)`,
      );
    // The agent re-reads agent/config.json about once a second: wait until it applies our allow list.
    const deadline = Date.now() + 5000;
    let current: string[] = heartbeat.allow ?? [];
    while (!sameSet(current, this.config.allow) && Date.now() < deadline) {
      await sleep(Math.min(this.config.pollMs, 200));
      current = readHeartbeat(this.paths)?.heartbeat.allow ?? current;
    }
    if (!sameSet(current, this.config.allow))
      this.log.warn(`the running agent still allows [${current.join(', ')}] instead of [${this.config.allow.join(', ')}] (an older agent that does not reload agent/config.json?)`);
  }

  private async startViaRdp(): Promise<void> {
    const { paths, config } = this;
    // Playwright runs several worker processes; only one of them may open the RDP session.
    const owner = tryAcquireStartLock(paths, config.connectTimeoutMs + 30_000);
    try {
      // Another process may have finished starting the session between our first look and taking the lock.
      const running = owner ? readHeartbeat(paths) : undefined;
      if (heartbeatIsFresh(running, config.heartbeatStaleMs)) {
        await this.reuse(running);
        return;
      }
      if (owner) {
        this.rdp = new RdpSession(config, { runner: this.options.runner, tempDir: this.options.rdpTempDir });
        await this.rdp.open(async () => {
          await this.waitForHeartbeat();
        });
      } else {
        this.log.info('another process is opening the RDP session - waiting for its agent');
        await this.waitForHeartbeat();
      }
    } finally {
      if (owner) releaseStartLock(paths);
    }
  }

  private async waitForUserStartedAgent(): Promise<void> {
    this.log.warn(
      `waiting up to ${Math.ceil(this.config.connectTimeoutMs / 1000)}s for you to open the RDP session / start the agent (REMOTE_AGENT_START=${this.config.agentStart}). What to do:\n${setupHelp(this.config)}`,
    );
    await this.waitForHeartbeat();
  }

  private async waitForHeartbeat(): Promise<HeartbeatReading> {
    const deadline = Date.now() + this.config.connectTimeoutMs;
    for (;;) {
      const reading = readHeartbeat(this.paths);
      if (heartbeatIsFresh(reading, this.config.heartbeatStaleMs)) {
        const { heartbeat } = reading;
        this.log.info(`agent is up (pid ${heartbeat.pid}, ${heartbeat.user}@${heartbeat.host}, session ${heartbeat.sessionId}, interactive ${heartbeat.interactive})`);
        return reading;
      }
      if (Date.now() >= deadline) throw this.agentNotStarted();
      await sleep(Math.min(this.config.pollMs, Math.max(10, deadline - Date.now())));
    }
  }

  private agentNotStarted(): RemoteError {
    const logTail = tailOfFile(this.paths.log, 5);
    const exited = this.rdp?.exited;
    const lines = [
      `no agent heartbeat appeared within ${this.config.connectTimeoutMs}ms (waiting for ${this.paths.heartbeat}).`,
      ...(exited ? [`Note: our mstsc window ended (exit code ${exited.code}) - the login or the connection probably failed.`] : []),
      'Likely causes, most common first:',
      `  1. The RDP login failed: wrong user / password / domain, the account may not log on through Remote Desktop, or ${this.config.host}:${this.config.port} is not reachable from this machine.`,
      `  2. Drive redirection is disabled on the host by policy (GPO "Do not allow drive redirection"): \\\\tsclient\\${this.config.driveLetter} never appears in the session.`,
      `  3. The server ignored "alternate shell" (it starts only the shell its policy allows): use REMOTE_AGENT_START=startup or manual (automation-remote setup-help).`,
      '  4. PowerShell is blocked on the host (execution policy set by GPO, AppLocker, constrained language): the agent never starts.',
      `  5. The agent started and crashed: read ${this.paths.log}${logTail.length ? ` - last lines:\n      ${logTail.join('\n      ')}` : ' (it does not exist: the agent never ran)'}`,
    ];
    return new RemoteError('AGENT_NOT_STARTED', lines.join('\n'), { operation: 'connect' });
  }

  private unregister(): void {
    if (this.clientFile) removeQuietly(this.clientFile);
    this.clientFile = undefined;
  }

  // ------------------------------------------------------------------------------------------------ requests

  /**
   * Sends one request and waits for its answer. Many may be in flight at once (each has its own id); the agent
   * works through them one at a time, so the timeout includes the time spent queueing. Connects first if needed.
   */
  async request<R = unknown, P = unknown>(type: RemoteRequestType, payload: P, options: { timeoutMs?: number } = {}): Promise<R> {
    await this.connect();
    return this.exchange<R, P>(type, payload, options.timeoutMs ?? this.config.requestTimeoutMs);
  }

  private exchange<R, P>(type: RemoteRequestType, payload: P, timeoutMs: number): Promise<R> {
    const id = newRequestId();
    const request: RemoteRequest<P> = {
      v: PROTOCOL_VERSION,
      id,
      type,
      payload,
      timeoutMs,
      createdAt: new Date().toISOString(),
      correlationId: getCorrelationId(),
    };
    const requestFile = path.join(this.paths.requests, `${id}.json`);
    const responseFile = path.join(this.paths.responses, `${id}.json`);
    // Only the request id and type are logged - never the payload (SQL, headers with tokens, connection strings).
    return adapterStep(
      this.name,
      type,
      async () => {
        const startedAt = Date.now();
        try {
          atomicWriteFile(requestFile, JSON.stringify(request));
        } catch (error) {
          throw new RemoteError('REMOTE_ERROR', `could not write the request into ${this.paths.requests}: ${(error as Error).message}`, { operation: type, cause: error });
        }
        let parseFailures = 0;
        try {
          for (;;) {
            let text: string | undefined;
            try {
              text = fs.readFileSync(responseFile, 'utf8');
            } catch {
              text = undefined;
            }
            if (text !== undefined) {
              try {
                return this.unwrap<R>(type, id, parseJsonText(text) as RemoteResponse<R>);
              } catch (error) {
                if (error instanceof RemoteError || ++parseFailures > 5)
                  throw error instanceof RemoteError ? error : new RemoteError('PROTOCOL', `the response file for ${type} is not valid JSON`, { operation: type, cause: error });
                // else: not complete yet (a writer that is not atomic) - look again
              }
            }
            const elapsed = Date.now() - startedAt;
            const age = heartbeatAgeMs(this.paths);
            if (age === undefined || age > this.config.heartbeatStaleMs)
              throw new RemoteError(
                'AGENT_STALE',
                `the agent on ${this.config.host} stopped answering while "${type}" was waiting (${age === undefined ? 'its heartbeat file is gone' : `no heartbeat for ${Math.round(age / 1000)}s, limit ${Math.round(this.config.heartbeatStaleMs / 1000)}s`}). The RDP session was probably closed, logged off or disconnected, or the agent crashed - see ${this.paths.log}.`,
                { operation: type },
              );
            if (elapsed >= timeoutMs)
              throw new RemoteError(
                'TIMEOUT',
                `no response to "${type}" after ${elapsed}ms (limit ${timeoutMs}ms). The agent is alive but did not answer: it handles one request at a time, so it may be busy with an earlier one, or the operation is slow.`,
                { operation: type },
              );
            await sleep(Math.min(this.config.pollMs, Math.max(5, timeoutMs - elapsed)));
          }
        } finally {
          removeQuietly(responseFile);
          removeQuietly(requestFile);
        }
      },
      { level: 'debug', details: { id } },
    );
  }

  private unwrap<R>(type: string, id: string, response: RemoteResponse<R>): R {
    if (response === null || typeof response !== 'object' || response.id !== id || typeof response.ok !== 'boolean')
      throw new RemoteError('PROTOCOL', `the response to ${type} is not a protocol response for request ${id}`, { operation: type });
    if (response.v !== PROTOCOL_VERSION)
      throw new RemoteError('PROTOCOL', `the agent answered with protocol version ${String(response.v)}, this client speaks ${PROTOCOL_VERSION}`, { operation: type });
    if (response.ok) return response.result as R;
    const error = response.error ?? { code: 'REMOTE_ERROR', message: 'the agent reported an error without details' };
    throw new RemoteError(WIRE_TO_ERROR[error.code] ?? 'REMOTE_ERROR', error.message, { operation: type, detail: error.detail, remoteCode: error.code });
  }

  // ------------------------------------------------------------------------------------------------ typed helpers

  private assertAllowed(capability: RemoteCapability, operation: string): void {
    if (this.config.allow.includes(capability)) return;
    throw new RemoteError(
      'DENIED',
      capability === 'exec'
        ? 'exec runs arbitrary commands on the host and must be listed explicitly: add "exec" to REMOTE_ALLOW (for example REMOTE_ALLOW=http,db,sap,exec)'
        : `REMOTE_ALLOW does not include "${capability}" - add it to allow ${operation}`,
      { operation },
    );
  }

  ping(): Promise<RemotePingResult> {
    return this.request<RemotePingResult>('ping', {}, { timeoutMs: Math.min(this.config.requestTimeoutMs, 30_000) });
  }

  /** An HTTP call made FROM the remote host (which can reach internal APIs this machine can not). */
  async http(request: RemoteHttpRequest): Promise<RemoteHttpResponse> {
    this.assertAllowed('http', 'http');
    return this.request<RemoteHttpResponse>('http', request, { timeoutMs: (request.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS) + CLIENT_MARGIN_MS });
  }

  private dbPayload(sql: string, params: unknown[] | undefined, options: DbCallOptions) {
    const provider = options.provider ?? this.config.dbProvider;
    const connectionString = options.connectionString ?? this.config.dbConnectionString;
    if (!provider) throw new RemoteError('REMOTE_ERROR', 'no DB provider: set REMOTE_DB_PROVIDER (for example System.Data.SqlClient) or pass options.provider', { operation: 'db' });
    if (!connectionString) throw new RemoteError('REMOTE_ERROR', 'no DB connection string: set REMOTE_DB_CONNECTION_STRING (in .env.<env>.local) or pass options.connectionString', { operation: 'db' });
    return { provider, connectionString, sql, params, maxRows: options.maxRows, timeoutMs: options.timeoutMs };
  }

  /** A SELECT run on the host. Parameters are positional: `@p0, @p1` for SqlClient, `?` for ODBC. */
  async dbQuery(sql: string, params?: unknown[], options: DbCallOptions = {}): Promise<RemoteDbResult> {
    this.assertAllowed('db', 'db.query');
    const payload = this.dbPayload(sql, params, options);
    return this.request<RemoteDbResult>('db.query', payload, { timeoutMs: (options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS) + CLIENT_MARGIN_MS });
  }

  /** INSERT / UPDATE / DELETE / DDL run on the host; `rowCount` is the number of rows affected. */
  async dbUpdate(sql: string, params?: unknown[], options: DbCallOptions = {}): Promise<RemoteDbResult> {
    this.assertAllowed('db', 'db.update');
    const payload = this.dbPayload(sql, params, options);
    return this.request<RemoteDbResult>('db.update', payload, { timeoutMs: (options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS) + CLIENT_MARGIN_MS });
  }

  /** Runs a command on the host. Refused here, before anything is sent, unless REMOTE_ALLOW lists `exec`. */
  async exec(request: RemoteExecRequest): Promise<RemoteExecResult> {
    this.assertAllowed('exec', 'exec');
    return this.request<RemoteExecResult>('exec', request, { timeoutMs: (request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + CLIENT_MARGIN_MS });
  }

  /** Starts a helper process on the host that speaks a line protocol (the SAP PowerShell bridge). Needs `sap` in REMOTE_ALLOW. */
  async startProcess(spec: { scriptText?: string; file?: string; args?: string[]; shell?: 'powershell' | 'cmd' }): Promise<RemoteProcess> {
    this.assertAllowed('sap', 'proc.start');
    if ((spec.scriptText === undefined) === (spec.file === undefined))
      throw new RemoteError('REMOTE_ERROR', 'startProcess needs exactly one of scriptText or file', { operation: 'proc.start' });
    const id = `proc-${randomBytes(5).toString('hex')}`;
    await this.request('proc.start', { id, ...spec });
    const process_ = new RemoteProcess(id, this);
    this.processes.add(process_);
    return process_;
  }

  /** @internal used by RemoteProcess */
  forget(process_: RemoteProcess): void {
    this.processes.delete(process_);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ping();
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------------ closing

  /**
   * Ends this process's use of the remote host. The session itself is only stopped by the LAST client process (the
   * worker processes of one run share it): a shutdown request when we started it (`alternate-shell`) or
   * REMOTE_LOGOFF is true, then our mstsc is closed and a drive mapping we created is removed. With
   * REMOTE_RDP_KEEP_OPEN (or `keepOpen`) everything is left running for the next run.
   */
  async close(options: { keepOpen?: boolean } = {}): Promise<void> {
    if (!this.connectPromise) return;
    try {
      await this.connectPromise;
    } catch {
      return; // a failed connect already cleaned up
    }
    await adapterStep(this.name, 'close', async () => {
      for (const process_ of [...this.processes]) await process_.stop().catch((error: unknown) => this.log.warn(`could not stop remote process ${process_.id}: ${(error as Error).message}`));
      const others = otherLiveClients(this.paths, this.clientFile);
      this.unregister();
      const keepOpen = options.keepOpen ?? this.config.keepOpen;
      if (others > 0) {
        this.log.info(`leaving the remote session open: ${others} other process(es) still use it`);
        this.rdp?.detach();
      } else if (keepOpen) {
        this.log.info('leaving the remote session open (REMOTE_RDP_KEEP_OPEN)');
        this.rdp?.detach();
      } else {
        if (this.config.agentStart === 'alternate-shell' || this.config.logoff) await this.stopAgent();
        await this.rdp?.close();
      }
      this.rdp = undefined;
      this.connected = false;
      this.connectPromise = undefined;
    });
  }

  /** Shutdown request; waits (briefly) for the heartbeat to go away. Never throws: the session may be gone already. */
  private async stopAgent(): Promise<void> {
    try {
      await this.exchange('shutdown', { logoff: this.config.logoff }, 10_000);
      const deadline = Date.now() + 5000;
      while (heartbeatAgeMs(this.paths) !== undefined && Date.now() < deadline) await sleep(100);
    } catch (error) {
      this.log.warn(`shutdown request: ${(error as Error).message}`);
    }
  }

  /**
   * For `automation-remote close` from another process: asks a running agent to shut down (and the Windows session to
   * log off when REMOTE_LOGOFF is true), then removes the drive mapping. Does not start anything.
   */
  async closeSession(): Promise<{ agentWasRunning: boolean; driveReleased: boolean }> {
    ensureMailbox(this.paths);
    const running = heartbeatIsFresh(readHeartbeat(this.paths), this.config.heartbeatStaleMs);
    if (running) await this.stopAgent();
    const driveReleased = RdpSession.releaseDrive(this.config, this.options.runner);
    return { agentWasRunning: running, driveReleased };
  }

  // ------------------------------------------------------------------------------------------------ diagnose

  /** Walks the chain stage by stage and says which link is broken and what to do about it. Connects (and so may open the RDP session). */
  async diagnose(options: DiagnoseOptions = {}): Promise<DiagnoseStage[]> {
    const stages: DiagnoseStage[] = [];
    const add = (name: string, ok: boolean, detail: string, hint = '') => {
      stages.push({ name, ok, detail, hint: ok ? '' : hint });
      return ok;
    };
    const run = async (name: string, hint: string, action: () => Promise<string>): Promise<boolean> => {
      try {
        return add(name, true, await action());
      } catch (error) {
        return add(name, false, (error as Error).message, hint);
      }
    };
    const { config } = this;

    add('configuration', true, `${config.host}:${config.port} as ${config.qualifiedUser ?? '(interactive login)'}, start=${config.agentStart}, drive ${config.driveLetter}:, allow=[${config.allow.join(', ')}]`);
    if (!(await run('mailbox folder', `make sure ${config.shareDir} can be created and written (REMOTE_SHARE_DIR)`, async () => {
      ensureMailbox(this.paths);
      const probe = path.join(this.paths.requests, `probe-${randomBytes(3).toString('hex')}.tmp`);
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe);
      return this.paths.root;
    }))) return stages;
    if (config.agentStart === 'alternate-shell') {
      const prerequisites = checkRdpPrerequisites(this.options.runner);
      const missing = prerequisites.tools.filter((t) => !t.found).map((t) => t.name);
      if (!add('RDP prerequisites', prerequisites.windows && missing.length === 0, prerequisites.windows ? (missing.length ? `not on the PATH: ${missing.join(', ')}` : 'mstsc, cmdkey and subst found') : `this machine is ${prerequisites.platform}, not Windows`, 'run on the Windows test machine, or use REMOTE_AGENT_START=startup|manual')) return stages;
    }
    if (!(await run('agent connection', 'follow the numbered checklist in the message; docs/REMOTE_DESKTOP.md > Troubleshooting', async () => {
      await this.connect();
      const heartbeat = readHeartbeat(this.paths)?.heartbeat;
      return heartbeat ? `agent ${heartbeat.agentVersion} pid ${heartbeat.pid}` : 'connected';
    }))) return stages;
    let interactive = true;
    if (!(await run('ping', 'the agent is up but not answering: see agent.log in the mailbox folder', async () => {
      const ping = await this.ping();
      interactive = ping.interactive;
      return `${ping.user}@${ping.host}, session ${ping.sessionId}, PowerShell ${ping.psVersion}, interactive ${ping.interactive}`;
    }))) return stages;
    add('interactive session', interactive, interactive ? 'the agent runs on an interactive desktop' : 'the agent is NOT on an interactive desktop', 'SAP GUI scripting only sees an interactive desktop: start the agent inside the logged-in RDP session, not as a service or scheduled task');
    if (options.url !== undefined) {
      const url = options.url;
      await run(`http GET ${url}`, 'the host could not fetch it: check the URL, DNS, proxy and firewall from the host itself', async () => {
        const response = await this.http({ method: 'GET', url });
        if (response.status >= 400) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return `HTTP ${response.status} in ${response.durationMs}ms`;
      });
    }
    if (options.db)
      await run('db SELECT 1', 'set REMOTE_DB_PROVIDER and REMOTE_DB_CONNECTION_STRING (.env.<env>.local); the provider must be installed on the host', async () => {
        const result = await this.dbQuery('SELECT 1');
        return `${result.rowCount} row(s)`;
      });
    if (options.exec)
      await run('exec hostname', 'add "exec" to REMOTE_ALLOW to allow it', async () => {
        const result = await this.exec({ command: 'hostname', timeoutMs: 15_000 });
        if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}: ${result.stderr.trim()}`);
        return result.stdout.trim();
      });
    return stages;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// one remote host per worker process

let shared: Promise<RemoteHost | undefined> | undefined;
let sharedHost: RemoteHost | undefined;

/**
 * The remote host for this worker process: connects once (lazily) and is then shared by every test in the process.
 * `undefined` when REMOTE_ENABLED is not true - use the local services then. A failed connect is remembered (every
 * later call fails at once instead of waiting out the timeout per test) until `closeRemoteHost()`.
 */
export function getRemoteHost(env: ConfigReader = loadEnv()): Promise<RemoteHost | undefined> {
  if (!shared) {
    shared = (async () => {
      const host = RemoteHost.fromEnv(env);
      if (!host) return undefined;
      sharedHost = host;
      await host.connect();
      return host;
    })();
  }
  return shared;
}

export async function closeRemoteHost(): Promise<void> {
  const host = sharedHost;
  shared = undefined;
  sharedHost = undefined;
  await host?.close();
}
