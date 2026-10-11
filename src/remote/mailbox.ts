import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteError } from './errors';
import { LAYOUT, type RemoteHeartbeat, type RemotePaths } from './protocol';

/**
 * Writes `text` to `file` atomically: first to `<file>.tmp`, then a rename, so a reader that lists the folder only
 * ever sees a complete file. (`beforeRename` is a test hook.)
 */
export function atomicWriteFile(file: string, text: string, hooks: { beforeRename?: (tmp: string) => void } = {}): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  hooks.beforeRename?.(tmp);
  fs.renameSync(tmp, file);
}

export function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFile(file, JSON.stringify(value));
}

/** Parses JSON text the PowerShell side wrote (UTF-8, possibly with a byte-order mark). */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort: a file that is locked right now is removed by the agent's housekeeping later
  }
}

export function ensureMailbox(paths: RemotePaths): void {
  for (const dir of [paths.requests, paths.responses, paths.agent, paths.clients]) fs.mkdirSync(dir, { recursive: true });
}

/** Removes requests and responses nobody is waiting for (the leftovers of a crashed run) - only when no agent runs. */
export function purgeMailbox(paths: RemotePaths): number {
  let removed = 0;
  for (const dir of [paths.requests, paths.responses]) {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      removeQuietly(path.join(dir, name));
      removed++;
    }
  }
  return removed;
}

/** Text with CRLF line endings: cmd.exe is unreliable with LF-only batch files, whatever git did to the checkout. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** The folder of this package that holds remote-agent.ps1 and start.cmd (the same relative path from src/ and from dist/). */
export function bundledAgentDir(): string {
  return path.resolve(__dirname, '..', '..', 'agent');
}

export interface InstallResult {
  /** Files written because they were missing or different (the agent version changed). */
  written: string[];
  unchanged: string[];
}

/** Copies the agent files into `<shareDir>/agent/`, CRLF-normalised, overwriting a file whose content differs. */
export function installAgentFiles(paths: RemotePaths, sourceDir: string = bundledAgentDir()): InstallResult {
  fs.mkdirSync(paths.agent, { recursive: true });
  const result: InstallResult = { written: [], unchanged: [] };
  for (const name of [LAYOUT.agentScript, LAYOUT.startCmd]) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source))
      throw new RemoteError('REMOTE_ERROR', `the agent file ${source} is missing from this package`, { operation: 'install agent' });
    const wanted = toCrlf(fs.readFileSync(source, 'utf8'));
    const target = path.join(paths.agent, name);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === wanted) result.unchanged.push(name);
    else {
      atomicWriteFile(target, wanted);
      result.written.push(name);
    }
  }
  return result;
}

export interface HeartbeatReading {
  heartbeat: RemoteHeartbeat;
  /**
   * Age of the file by ITS MODIFICATION TIME ON THIS MACHINE - not the `updatedAt` the host wrote - so a clock that is
   * wrong on the RDP host (no internet there) can not make a live agent look dead or a dead one look alive.
   */
  ageMs: number;
}

export function readHeartbeat(paths: RemotePaths): HeartbeatReading | undefined {
  try {
    const stat = fs.statSync(paths.heartbeat);
    const heartbeat = parseJsonText(fs.readFileSync(paths.heartbeat, 'utf8')) as RemoteHeartbeat;
    if (heartbeat === null || typeof heartbeat !== 'object') return undefined;
    return { heartbeat, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
  } catch {
    return undefined; // missing, or being replaced right now
  }
}

export function heartbeatIsFresh(reading: HeartbeatReading | undefined, staleMs: number): reading is HeartbeatReading {
  return reading !== undefined && reading.ageMs <= staleMs;
}

// ------------------------------------------------------------------------------------------------ client registry

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Records that this process uses the session; returns the file to remove again. */
export function registerClient(paths: RemotePaths): string {
  fs.mkdirSync(paths.clients, { recursive: true });
  const file = path.join(paths.clients, `${process.pid}-${randomBytes(4).toString('hex')}.json`);
  atomicWriteJson(file, { pid: process.pid, startedAt: new Date().toISOString() });
  return file;
}

/** Other client processes that are still alive (the files of dead ones are cleaned up on the way). */
export function otherLiveClients(paths: RemotePaths, ownFile: string | undefined): number {
  let live = 0;
  for (const name of fs.existsSync(paths.clients) ? fs.readdirSync(paths.clients) : []) {
    const file = path.join(paths.clients, name);
    if (file === ownFile || !name.endsWith('.json')) continue;
    let pid = -1;
    try {
      pid = Number((parseJsonText(fs.readFileSync(file, 'utf8')) as { pid?: number }).pid);
    } catch {
      // unreadable: treat as dead
    }
    if (pid > 0 && isAlive(pid)) live++;
    else removeQuietly(file);
  }
  return live;
}

// ------------------------------------------------------------------------------------------------ start lock

/**
 * Only one process at a time launches the RDP session (Playwright runs several worker processes; two mstsc windows
 * for the same login would take the session from each other). Returns true when the lock was taken; a lock older than
 * `staleMs` (its owner died) is taken over.
 */
export function tryAcquireStartLock(paths: RemotePaths, staleMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(paths.lock).mtimeMs <= staleMs) return false;
        removeQuietly(paths.lock);
      } catch {
        // vanished between the two calls: try again
      }
    }
  }
  return false;
}

export function releaseStartLock(paths: RemotePaths): void {
  removeQuietly(paths.lock);
}

export function tailOfFile(file: string, lines: number): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-lines);
  } catch {
    return [];
  }
}

/** Age of agent/heartbeat.json by its modification time here, or undefined when there is no heartbeat file. */
export function heartbeatAgeMs(paths: RemotePaths): number | undefined {
  try {
    return Math.max(0, Date.now() - fs.statSync(paths.heartbeat).mtimeMs);
  } catch {
    return undefined;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
