import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigReader } from '../../src/config/env';
import { RemoteConfig, type RemoteConfigValues } from '../../src/remote/config';
import { RemoteHost, type RemoteHostOptions } from '../../src/remote/remoteHost';
import type { CommandResult, CommandRunner, LaunchedProcess } from '../../src/remote/rdp';
import { StandInAgent, type StandInOptions } from './standInAgent';

const created: string[] = [];

export function tmpDir(prefix = 'remote-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Removes every directory tmpDir() made in this worker - call from test.afterAll. */
export function cleanTmpDirs(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** A manual-start config with fast timings (the stand-in beats every 50 ms; "stale" is 1 s). */
export function testConfig(shareDir: string, overrides: Partial<RemoteConfigValues> = {}): RemoteConfig {
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

export function reader(values: Record<string, string>): ConfigReader {
  return new ConfigReader(values);
}

export interface Rig {
  shareDir: string;
  config: RemoteConfig;
  agent: StandInAgent;
  host: RemoteHost;
  cleanup(): Promise<void>;
}

/** A started stand-in agent and a connected host over one temporary mailbox. */
export async function startRig(options: { config?: Partial<RemoteConfigValues>; agent?: Partial<StandInOptions>; connect?: boolean; host?: RemoteHostOptions } = {}): Promise<Rig> {
  const shareDir = tmpDir();
  const config = testConfig(shareDir, options.config);
  const agent = new StandInAgent({ shareDir, ...options.agent });
  await agent.start();
  const host = new RemoteHost(config, options.host);
  if (options.connect !== false) await host.connect();
  return {
    shareDir,
    config,
    agent,
    host,
    async cleanup() {
      await host.close().catch(() => undefined);
      await agent.stop();
      fs.rmSync(shareDir, { recursive: true, force: true });
    },
  };
}

export interface TestServer {
  url: string;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1: /echo, /redirect (302 to /echo), /slow (answers after 2 s). */
export async function startHttpServer(): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/echo' });
        res.end();
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2000);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'x-reply': 'from-test-server' });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** Runs `action` while collecting everything written to stdout (the logger writes there). */
export async function captureStdout<T>(action: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; output: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
  let result: T | undefined;
  let error: unknown;
  try {
    result = await action();
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = original;
  }
  return { result, error, output: chunks.join('') };
}

export interface RecordedCall {
  kind: 'run' | 'exists' | 'launch' | 'pathExists';
  command: string;
  args: string[];
}

/** A CommandRunner that records every call and answers from a script - no real mstsc / cmdkey / subst anywhere. */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  /** What `subst` (no arguments) prints. */
  substList = '';
  missingTools = new Set<string>();
  realDrives = new Set<string>();
  /** Return a result to override the default success for a `run`. */
  onRun?: (command: string, args: string[]) => CommandResult | undefined;
  launchError?: Error;
  onLaunch?: (args: string[]) => void;
  launched: FakeProcess[] = [];

  constructor(readonly platform: NodeJS.Platform = 'win32') {}

  run(command: string, args: string[]): CommandResult {
    this.calls.push({ kind: 'run', command, args });
    const custom = this.onRun?.(command, args);
    if (custom) return custom;
    if (command === 'subst' && args.length === 0) return { status: 0, stdout: this.substList, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }

  exists(command: string): boolean {
    this.calls.push({ kind: 'exists', command, args: [] });
    return !this.missingTools.has(command);
  }

  launch(command: string, args: string[]): LaunchedProcess {
    this.calls.push({ kind: 'launch', command, args });
    if (this.launchError) throw this.launchError;
    this.onLaunch?.(args);
    const proc = new FakeProcess();
    this.launched.push(proc);
    return proc;
  }

  pathExists(target: string): boolean {
    this.calls.push({ kind: 'pathExists', command: target, args: [] });
    return this.realDrives.has(target.slice(0, 1).toUpperCase());
  }

  /** Commands run (not the lookups), as `program arg arg`. */
  get commands(): string[] {
    return this.calls.filter((c) => c.kind === 'run' || c.kind === 'launch').map((c) => `${c.kind === 'launch' ? 'launch ' : ''}${c.command} ${c.args.join(' ')}`.trim());
  }
}

export class FakeProcess implements LaunchedProcess {
  pid = 4242;
  killed = false;
  unrefd = false;
  exited = false;
  private callbacks: Array<(code: number | null) => void> = [];
  hasExited(): boolean {
    return this.exited;
  }
  onExit(callback: (code: number | null) => void): void {
    this.callbacks.push(callback);
  }
  kill(): void {
    this.killed = true;
    this.end(1);
  }
  unref(): void {
    this.unrefd = true;
  }
  end(code: number | null): void {
    this.exited = true;
    for (const cb of this.callbacks.splice(0)) cb(code);
  }
}
