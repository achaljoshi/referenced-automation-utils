import * as path from 'node:path';
import { inspect } from 'node:util';
import { loadEnv, type ConfigReader } from '../config/env';
import { RemoteError } from './errors';

/** What the agent may be asked to do. `exec` runs arbitrary commands on the host and is never on by default. */
export const REMOTE_CAPABILITIES = ['http', 'db', 'sap', 'exec'] as const;
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];
export const DEFAULT_ALLOW: RemoteCapability[] = ['http', 'db', 'sap'];

/**
 * How the agent gets started inside the RDP session of the host:
 * - `alternate-shell`: mstsc's `alternate shell` starts the agent instead of Explorer (this machine logs in for you);
 * - `startup`: the agent was installed once in the host's Startup folder and starts at logon (you open the RDP session);
 * - `manual`: you start it from `\\tsclient\<L>\agent\start.cmd` yourself.
 */
export const AGENT_START_MODES = ['alternate-shell', 'startup', 'manual'] as const;
export type RemoteAgentStart = (typeof AGENT_START_MODES)[number];

export interface RemoteConfigValues {
  host: string;
  port: number;
  user?: string;
  password?: string;
  domain?: string;
  shareDir: string;
  driveLetter: string;
  agentStart: RemoteAgentStart;
  allow: RemoteCapability[];
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  pollMs: number;
  heartbeatMs: number;
  heartbeatStaleMs: number;
  width: number;
  height: number;
  keepOpen: boolean;
  logoff: boolean;
  dbProvider?: string;
  dbConnectionString?: string;
}

const MASK = '********';

function fail(message: string): never {
  throw new RemoteError('REMOTE_ERROR', message, { operation: 'config' });
}

function checkRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`${name} must be a whole number between ${min} and ${max} (got ${value})`);
  return value;
}

/**
 * Settings for running steps on a remote desktop host (see docs/REMOTE_DESKTOP.md). Secrets (the RDP password, the DB
 * connection string) are held in non-enumerable properties and masked by `toJSON()` / `util.inspect`, so spreading,
 * `JSON.stringify`, `console.log` and the logger can not print them; no error message ever contains them.
 */
export class RemoteConfig implements RemoteConfigValues {
  declare readonly host: string;
  declare readonly port: number;
  declare readonly user?: string;
  declare readonly domain?: string;
  declare readonly shareDir: string;
  declare readonly driveLetter: string;
  declare readonly agentStart: RemoteAgentStart;
  declare readonly allow: RemoteCapability[];
  declare readonly connectTimeoutMs: number;
  declare readonly requestTimeoutMs: number;
  declare readonly pollMs: number;
  declare readonly heartbeatMs: number;
  declare readonly heartbeatStaleMs: number;
  declare readonly width: number;
  declare readonly height: number;
  declare readonly keepOpen: boolean;
  declare readonly logoff: boolean;
  declare readonly dbProvider?: string;
  declare readonly password?: string;
  declare readonly dbConnectionString?: string;

  private constructor(values: RemoteConfigValues) {
    for (const [key, value] of Object.entries(values)) {
      const secret = key === 'password' || key === 'dbConnectionString';
      Object.defineProperty(this, key, { value, enumerable: !secret, writable: false });
    }
  }

  /** Applies the defaults and validates; every message names the setting and never contains a secret. */
  static create(input: Partial<RemoteConfigValues> & { host: string }): RemoteConfig {
    const host = (input.host ?? '').trim();
    if (!host) fail('REMOTE_RDP_HOST is required when REMOTE_ENABLED=true');
    if (/[\s/\\]/.test(host)) fail(`REMOTE_RDP_HOST "${host}" must be a host name or address, without a scheme, path or spaces`);

    let user = input.user?.trim() || undefined;
    let domain = input.domain?.trim() || undefined;
    const slash = user?.indexOf('\\') ?? -1;
    if (user && slash > 0) {
      const fromUser = user.slice(0, slash);
      user = user.slice(slash + 1);
      if (domain && domain.toLowerCase() !== fromUser.toLowerCase())
        fail(`REMOTE_RDP_USER names the domain "${fromUser}" but REMOTE_RDP_DOMAIN is "${domain}" - set one of them`);
      domain = fromUser;
    }
    if (user !== undefined && user === '') fail('REMOTE_RDP_USER is empty after the domain prefix');

    const agentStart = input.agentStart ?? 'alternate-shell';
    if (!AGENT_START_MODES.includes(agentStart))
      fail(`REMOTE_AGENT_START "${String(agentStart)}" is not one of: ${AGENT_START_MODES.join(', ')}`);
    if (agentStart === 'alternate-shell' && (!user || !input.password))
      fail('REMOTE_RDP_USER and REMOTE_RDP_PASSWORD are required with REMOTE_AGENT_START=alternate-shell (this machine logs in to the host); use startup or manual to log in yourself');

    const driveLetter = (input.driveLetter ?? 'R').trim().toUpperCase();
    if (!/^[A-Z]$/.test(driveLetter)) fail(`REMOTE_DRIVE_LETTER "${input.driveLetter}" must be a single letter`);
    if (['A', 'B', 'C'].includes(driveLetter))
      fail(`REMOTE_DRIVE_LETTER ${driveLetter} would shadow a real drive - use a spare letter such as R`);

    const allow = [...new Set((input.allow ?? DEFAULT_ALLOW).map((a) => String(a).trim().toLowerCase()))] as RemoteCapability[];
    for (const capability of allow)
      if (!REMOTE_CAPABILITIES.includes(capability))
        fail(`REMOTE_ALLOW entry "${capability}" is not one of: ${REMOTE_CAPABILITIES.join(', ')}`);

    const heartbeatMs = checkRange('REMOTE_HEARTBEAT_MS', input.heartbeatMs ?? 2000, 100, 60_000);
    const heartbeatStaleMs = checkRange('REMOTE_HEARTBEAT_STALE_MS', input.heartbeatStaleMs ?? 10_000, 200, 3_600_000);
    if (heartbeatStaleMs < heartbeatMs * 2)
      fail(`REMOTE_HEARTBEAT_STALE_MS (${heartbeatStaleMs}) must be at least twice REMOTE_HEARTBEAT_MS (${heartbeatMs}), or a healthy agent looks dead`);

    return new RemoteConfig({
      host,
      port: checkRange('REMOTE_RDP_PORT', input.port ?? 3389, 1, 65_535),
      user,
      password: input.password || undefined,
      domain,
      shareDir: path.resolve(input.shareDir ?? path.join(process.cwd(), '.remote-mailbox')),
      driveLetter,
      agentStart,
      allow,
      connectTimeoutMs: checkRange('REMOTE_CONNECT_TIMEOUT_MS', input.connectTimeoutMs ?? 180_000, 1, 3_600_000),
      requestTimeoutMs: checkRange('REMOTE_REQUEST_TIMEOUT_MS', input.requestTimeoutMs ?? 60_000, 1, 3_600_000),
      pollMs: checkRange('REMOTE_POLL_MS', input.pollMs ?? 200, 10, 10_000),
      heartbeatMs,
      heartbeatStaleMs,
      width: checkRange('REMOTE_RDP_WIDTH', input.width ?? 1280, 200, 8192),
      height: checkRange('REMOTE_RDP_HEIGHT', input.height ?? 800, 200, 8192),
      keepOpen: input.keepOpen ?? false,
      logoff: input.logoff ?? false,
      dbProvider: input.dbProvider?.trim() || undefined,
      dbConnectionString: input.dbConnectionString || undefined,
    });
  }

  /** The login name as `cmdkey` and mstsc need it: `DOMAIN\user` when a domain is set, else the plain user. */
  get qualifiedUser(): string | undefined {
    if (!this.user) return undefined;
    return this.domain ? `${this.domain}\\${this.user}` : this.user;
  }

  /** The folder (on the test machine) that appears as `\\tsclient\<L>` inside the RDP session. */
  get remoteRoot(): string {
    return `\\\\tsclient\\${this.driveLetter}`;
  }

  /** A copy that is safe to log or serialise: secrets are masked. */
  toJSON(): Record<string, unknown> {
    return {
      ...(this as Record<string, unknown>),
      password: this.password ? MASK : undefined,
      dbConnectionString: this.dbConnectionString ? MASK : undefined,
    };
  }

  [inspect.custom](): string {
    return `RemoteConfig ${inspect(this.toJSON(), { depth: 2 })}`;
  }
}

/**
 * Reads the REMOTE_* settings. Returns `undefined` unless `REMOTE_ENABLED` is true - the signal for callers to use
 * their local services (DB, API, SAP GUI on this machine) instead of the remote host. Secrets belong in
 * `.env.<env>.local`, never in a committed file.
 */
export function remoteConfigFromEnv(env: ConfigReader = loadEnv()): RemoteConfig | undefined {
  if (!env.getBoolean('REMOTE_ENABLED', false)) return undefined;
  const host = env.getOptional('REMOTE_RDP_HOST');
  if (host === undefined || host.trim() === '') fail('REMOTE_RDP_HOST is required when REMOTE_ENABLED=true');
  return RemoteConfig.create({
    host,
    port: env.getInt('REMOTE_RDP_PORT', 3389),
    user: env.getOptional('REMOTE_RDP_USER'),
    password: env.getOptional('REMOTE_RDP_PASSWORD'),
    domain: env.getOptional('REMOTE_RDP_DOMAIN'),
    shareDir: env.getOptional('REMOTE_SHARE_DIR'),
    driveLetter: env.get('REMOTE_DRIVE_LETTER', 'R'),
    agentStart: env.get('REMOTE_AGENT_START', 'alternate-shell').trim().toLowerCase() as RemoteAgentStart,
    allow: env.getList('REMOTE_ALLOW', DEFAULT_ALLOW) as RemoteCapability[],
    connectTimeoutMs: env.getInt('REMOTE_CONNECT_TIMEOUT_MS', 180_000),
    requestTimeoutMs: env.getInt('REMOTE_REQUEST_TIMEOUT_MS', 60_000),
    pollMs: env.getInt('REMOTE_POLL_MS', 200),
    heartbeatMs: env.getInt('REMOTE_HEARTBEAT_MS', 2000),
    heartbeatStaleMs: env.getInt('REMOTE_HEARTBEAT_STALE_MS', 10_000),
    width: env.getInt('REMOTE_RDP_WIDTH', 1280),
    height: env.getInt('REMOTE_RDP_HEIGHT', 800),
    keepOpen: env.getBoolean('REMOTE_RDP_KEEP_OPEN', false),
    logoff: env.getBoolean('REMOTE_LOGOFF', false),
    dbProvider: env.getOptional('REMOTE_DB_PROVIDER'),
    dbConnectionString: env.getOptional('REMOTE_DB_CONNECTION_STRING'),
  });
}
