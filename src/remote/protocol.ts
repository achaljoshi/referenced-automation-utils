import * as path from 'node:path';
import type { RemoteCapability } from './config';

/**
 * The wire contract of the "RDP drive mailbox": a folder on the test machine (for example an AWS WorkSpace) that
 * appears inside the RDP session of the remote host as `\\tsclient\<L>`. The TypeScript client, the TypeScript stand-in
 * agent used by the tests and the PowerShell agent (agent/remote-agent.ps1, which repeats the names below as
 * constants) all speak it. tests/remoteProtocol.spec.ts fails when the PowerShell file and this file drift apart.
 *
 * Folder layout under the share dir:
 *   requests/<id>.json      client -> agent   one request per file
 *   responses/<id>.json     agent  -> client  the answer, same id
 *   agent/remote-agent.ps1  the agent (copied here by the client)
 *   agent/start.cmd         starts it by hand / from the Startup folder
 *   agent/config.json       written by the client: allow list, pollMs, heartbeatMs
 *   agent/heartbeat.json    written by the agent every heartbeatMs
 *   agent/agent.log         the agent's own log (never request bodies or credentials)
 *   agent/clients/          one file per live client process (so the last one out closes the session)
 *   agent/starting.lock     held by the process that is launching RDP (so parallel workers launch one session)
 *
 * Every file is written atomically on both sides: write `<name>.tmp`, then rename. Readers only look at `*.json`.
 */

export const PROTOCOL_VERSION = 1;
/** The version of agent/remote-agent.ps1 - bump it with every change to the script. `$AgentVersion` in the script must match. */
export const AGENT_VERSION = '1.0.0';
/** A request nobody has answered after this long is dropped by the agent (and an orphaned response deleted). */
export const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;
/** exec stdout / stderr are each cut to this many characters. */
export const MAX_EXEC_OUTPUT = 1024 * 1024;
export const DEFAULT_MAX_ROWS = 10_000;

export const LAYOUT = {
  requestsDir: 'requests',
  responsesDir: 'responses',
  agentDir: 'agent',
  clientsDir: 'clients',
  agentScript: 'remote-agent.ps1',
  startCmd: 'start.cmd',
  configFile: 'config.json',
  heartbeatFile: 'heartbeat.json',
  logFile: 'agent.log',
  lockFile: 'starting.lock',
} as const;

export interface RemotePaths {
  root: string;
  requests: string;
  responses: string;
  agent: string;
  clients: string;
  script: string;
  startCmd: string;
  config: string;
  heartbeat: string;
  log: string;
  lock: string;
}

export function remotePaths(shareDir: string): RemotePaths {
  const agent = path.join(shareDir, LAYOUT.agentDir);
  return {
    root: shareDir,
    requests: path.join(shareDir, LAYOUT.requestsDir),
    responses: path.join(shareDir, LAYOUT.responsesDir),
    agent,
    clients: path.join(agent, LAYOUT.clientsDir),
    script: path.join(agent, LAYOUT.agentScript),
    startCmd: path.join(agent, LAYOUT.startCmd),
    config: path.join(agent, LAYOUT.configFile),
    heartbeat: path.join(agent, LAYOUT.heartbeatFile),
    log: path.join(agent, LAYOUT.logFile),
    lock: path.join(agent, LAYOUT.lockFile),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// request / response envelopes

export const REQUEST_TYPES = ['ping', 'http', 'db.query', 'db.update', 'exec', 'proc.start', 'proc.send', 'proc.stop', 'shutdown'] as const;
export type RemoteRequestType = (typeof REQUEST_TYPES)[number];

/** Error codes the agent answers with. */
export const ERROR_CODES = ['DENIED', 'BAD_REQUEST', 'TIMEOUT', 'REMOTE_ERROR', 'NOT_FOUND'] as const;
export type RemoteErrorCodeOnWire = (typeof ERROR_CODES)[number];

/**
 * Which `REMOTE_ALLOW` entry each request type needs (`undefined`: always allowed). The process requests need `sap`
 * (they host the SAP PowerShell bridge) - but note that a `scriptText` is arbitrary PowerShell, so `sap` is nearly as
 * powerful as `exec`: grant it only to suites that drive SAP GUI.
 */
export const CAPABILITY_FOR_TYPE: Record<RemoteRequestType, RemoteCapability | undefined> = {
  ping: undefined,
  http: 'http',
  'db.query': 'db',
  'db.update': 'db',
  exec: 'exec',
  'proc.start': 'sap',
  'proc.send': 'sap',
  'proc.stop': 'sap',
  shutdown: undefined,
};

export interface RemoteRequest<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: RemoteRequestType;
  payload: P;
  /** How long the client waits in total (queueing included). */
  timeoutMs: number;
  createdAt: string;
  /** The test's correlation id (ADR 0004), so one value can be grepped in the test log and in agent.log. */
  correlationId?: string;
}

export interface RemoteResponseError {
  code: RemoteErrorCodeOnWire;
  message: string;
  detail?: string;
}

export interface RemoteResponse<R = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  result?: R;
  error?: RemoteResponseError;
  durationMs: number;
}

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------------------------------------------------
// payloads and results

export interface RemoteHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Request body, base64 (see `encodeBody`). */
  bodyBase64?: string;
  /** Agent-side limit for the whole call. Default 30 000. */
  timeoutMs?: number;
  /** Follow 3xx responses. Default false: the 302 itself is the answer. */
  followRedirects?: boolean;
  /** Accept any TLS certificate (internal hosts with a private CA). Default false. */
  ignoreTlsErrors?: boolean;
  /** Use the host's proxy settings. Default false: the host reaches internal APIs directly. */
  useProxy?: boolean;
}

export interface RemoteHttpResponse {
  status: number;
  statusText: string;
  /** Several values of one header are joined with ", ". */
  headers: Record<string, string>;
  bodyBase64: string;
  /** The final URL (after redirects, when followed). */
  url: string;
  durationMs: number;
}

/**
 * SQL goes through a .NET provider factory on the host (`System.Data.SqlClient`, `System.Data.Odbc`, ...). Parameters
 * are positional and named `p0`, `p1`, ...: write `@p0` for SqlClient, `?` for ODBC / OLE DB.
 */
export interface RemoteDbRequest {
  provider: string;
  connectionString: string;
  sql: string;
  params?: unknown[];
  /** Rows beyond this are not returned (`truncated: true`). Default 10 000. */
  maxRows?: number;
  /** Agent-side command timeout. Default 30 000. */
  timeoutMs?: number;
}

/**
 * Values are normalised for JSON: NULL -> null, date/time -> ISO 8601 string, binary -> base64 string, decimal and
 * integers beyond 2^53 -> string (no precision lost on the way).
 */
export interface RemoteDbResult {
  rows: Array<Record<string, unknown>>;
  /** Rows returned (db.query) or rows affected (db.update). */
  rowCount: number;
  truncated?: boolean;
}

export interface RemoteExecRequest {
  /**
   * Without `shell`: the program to start, `args` are its arguments. With `shell: 'powershell'` or `'cmd'`: a command
   * line for that shell; `args` (if any) are appended, quoted for it.
   */
  command: string;
  args?: string[];
  shell?: 'powershell' | 'cmd';
  cwd?: string;
  /** Default 60 000. The process tree is killed when it is exceeded (`timedOut: true`). */
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RemoteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A helper process on the host that speaks a line protocol on stdin / stdout (used to host the SAP PowerShell
 * bridge). `scriptText` is written to a temporary .ps1 in %TEMP% and run with `powershell -NoProfile
 * -ExecutionPolicy Bypass -File`; `file` runs a script that is already on the host. Texts are UTF-8: the script
 * should set [Console]::InputEncoding / OutputEncoding accordingly. The process must not print unsolicited lines.
 */
export interface RemoteProcStartRequest {
  id: string;
  scriptText?: string;
  file?: string;
  args?: string[];
  shell?: 'powershell' | 'cmd';
}

export interface RemoteProcSendRequest {
  id: string;
  /** One line, no line breaks. */
  line: string;
  /** Wait for the answer line at most this long; on expiry the process is stopped (a late answer would be taken for the next one). */
  timeoutMs: number;
}

export interface RemoteProcSendResult {
  line: string;
}

export interface RemoteProcStopRequest {
  id: string;
}

export interface RemoteShutdownRequest {
  /** Also log the Windows session off (for an interactive session that was not started with `alternate shell`). */
  logoff?: boolean;
}

export interface RemotePingResult {
  host: string;
  user: string;
  sessionId: number;
  interactive: boolean;
  psVersion: string;
  agentVersion: string;
  pid: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// files the agent keeps

export interface RemoteAgentConfigFile {
  allow: RemoteCapability[];
  pollMs: number;
  heartbeatMs: number;
}

/** The fields of agent/heartbeat.json (the PowerShell agent writes every one of them). */
export const HEARTBEAT_FIELDS = ['agentVersion', 'pid', 'host', 'user', 'sessionId', 'interactive', 'psVersion', 'startedAt', 'updatedAt', 'allow'] as const;

export interface RemoteHeartbeat {
  agentVersion: string;
  pid: number;
  host: string;
  user: string;
  sessionId: number;
  interactive: boolean;
  psVersion: string;
  startedAt: string;
  updatedAt: string;
  allow: string[];
}

/** HTTP bodies cross the wire as base64. */
export function encodeBody(body: string | Buffer): string {
  return Buffer.from(body).toString('base64');
}

export function decodeBody(response: Pick<RemoteHttpResponse, 'bodyBase64'>): Buffer {
  return Buffer.from(response.bodyBase64, 'base64');
}

export function bodyText(response: Pick<RemoteHttpResponse, 'bodyBase64'>): string {
  return decodeBody(response).toString('utf8');
}
