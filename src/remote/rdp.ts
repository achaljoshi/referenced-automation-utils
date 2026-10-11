/**
 * Launches the RDP session that carries the "drive mailbox" (see protocol.ts) from the test machine (for example an
 * AWS WorkSpace) to the remote host: `subst` makes a drive letter for the mailbox folder, `cmdkey` hands the login to
 * mstsc for the few seconds it connects, `mstsc` opens the session with ONLY that drive redirected, and its
 * `alternate shell` starts the agent instead of Explorer.
 *
 * *** NOT VERIFIED on a real Windows host. *** The development machine for this code is macOS: nothing here has been
 * run against mstsc, cmdkey, subst or a real RDP server. It is driven through an injectable CommandRunner, and the
 * tests (tests/remoteRdp.spec.ts) assert the exact commands against a recording fake. Treat the first run on a real
 * host as the verification (`automation-remote doctor`, then `automation-remote check`).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../logger/logger';
import type { RemoteConfig } from './config';
import { RemoteError } from './errors';
import { LAYOUT } from './protocol';

export interface CommandResult {
  /** Exit code; null when the program could not be started or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (not found, no permission). */
  error?: string;
}

export interface LaunchedProcess {
  pid?: number;
  hasExited(): boolean;
  /** Calls back once with the exit code when the process ends. */
  onExit(callback: (code: number | null) => void): void;
  kill(): void;
  /** Lets this process exit without waiting for it (the session stays open). */
  unref(): void;
}

/**
 * Everything RdpSession needs from the operating system, so tests can record the calls and Windows-only behaviour can
 * be exercised on any machine. `platform` is part of it so a test can claim to be on win32 or not without patching
 * the global `process.platform`.
 */
export interface CommandRunner {
  readonly platform: NodeJS.Platform;
  /** Runs a program to completion (no shell). */
  run(command: string, args: string[], options?: { timeoutMs?: number }): CommandResult;
  /** Is the program on the PATH? */
  exists(command: string): boolean;
  /** Starts a program detached from this process (mstsc). Throws when it cannot be started. */
  launch(command: string, args: string[]): LaunchedProcess;
  pathExists(target: string): boolean;
}

export function createCommandRunner(platform: NodeJS.Platform = process.platform): CommandRunner {
  return {
    platform,
    run(command, args, options = {}) {
      const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs ?? 30_000 });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error?.message,
      };
    },
    exists(command) {
      const finder = platform === 'win32' ? 'where' : 'which';
      return spawnSync(finder, [command], { windowsHide: true }).status === 0;
    },
    launch(command, args) {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      // Without a listener a failed start (ENOENT) would be an unhandled 'error' event and kill the worker.
      child.once('error', () => {
        exited = true;
      });
      return {
        pid: child.pid,
        hasExited: () => exited,
        onExit: (callback) => {
          child.once('exit', (code) => callback(code));
          child.once('error', () => callback(null));
        },
        kill: () => {
          child.kill();
        },
        unref: () => child.unref(),
      };
    },
    pathExists: (target) => fs.existsSync(target),
  };
}

/** The command the host's `alternate shell` runs: PowerShell starts the agent from the redirected drive. */
export function agentCommandLine(driveLetter: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File \\\\tsclient\\${driveLetter}\\${LAYOUT.agentDir}\\${LAYOUT.agentScript}`;
}

/**
 * The .rdp file for the session. It carries NO password (the credential comes from `cmdkey`, see RdpSession) and
 * redirects exactly one thing: the subst drive. Clipboard, printers, COM ports, smart cards, audio and every other
 * drive stay out of the session.
 */
export function buildRdpFile(config: RemoteConfig, agentCommand: string = agentCommandLine(config.driveLetter)): string {
  const lines = [
    `full address:s:${config.host}:${config.port}`,
    `username:s:${config.user ?? ''}`,
    ...(config.domain ? [`domain:s:${config.domain}`] : []),
    'prompt for credentials:i:0',
    'enablecredsspsupport:i:1',
    'authentication level:i:2',
    `drivestoredirect:s:${config.driveLetter}:\\`,
    'redirectclipboard:i:0',
    'redirectprinters:i:0',
    'redirectcomports:i:0',
    'redirectsmartcards:i:0',
    'redirectposdevices:i:0',
    'devicestoredirect:s:',
    'audiomode:i:2',
    'audiocapturemode:i:0',
    'screen mode id:i:1',
    `desktopwidth:i:${config.width}`,
    `desktopheight:i:${config.height}`,
    'autoreconnection enabled:i:1',
    ...(config.agentStart === 'alternate-shell' ? [`alternate shell:s:${agentCommand}`, 'shell working directory:s:C:\\'] : []),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** `subst` with no arguments prints `R:\: => C:\some\folder`; returns the folder a letter points at, if any. */
export function parseSubstList(output: string, letter: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z]):\\: => (.+?)\s*$/.exec(line);
    if (match && (match[1] as string).toUpperCase() === letter.toUpperCase()) return match[2];
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** `/pass:...` replaced, so a command line can be logged or shown. */
export function maskCommandLine(args: string[]): string[] {
  return args.map((arg) => (/^\/pass:/i.test(arg) ? '/pass:********' : arg));
}

export interface RdpPrerequisites {
  platform: NodeJS.Platform;
  windows: boolean;
  tools: Array<{ name: string; found: boolean }>;
}

export const RDP_TOOLS = ['mstsc', 'cmdkey', 'subst'] as const;

export function checkRdpPrerequisites(runner: CommandRunner = createCommandRunner()): RdpPrerequisites {
  const windows = runner.platform === 'win32';
  return {
    platform: runner.platform,
    windows,
    tools: RDP_TOOLS.map((name) => ({ name, found: windows && runner.exists(name) })),
  };
}

export interface RdpSessionOptions {
  runner?: CommandRunner;
  /** Where the .rdp file is written. Default: the OS temp dir. */
  tempDir?: string;
}

export class RdpSession {
  private readonly runner: CommandRunner;
  private readonly log = getLogger('remote-rdp');
  private readonly credentialTarget: string;
  private substCreated = false;
  private credentialStored = false;
  private rdpFile?: string;
  private child?: LaunchedProcess;
  private childExit: { code: number | null } | undefined;

  constructor(
    private readonly config: RemoteConfig,
    private readonly options: RdpSessionOptions = {},
  ) {
    this.runner = options.runner ?? createCommandRunner();
    this.credentialTarget = `TERMSRV/${config.host}`;
  }

  /** Set once our mstsc has ended (the login failed, or somebody closed the window). */
  get exited(): { code: number | null } | undefined {
    return this.childExit;
  }

  get rdpFilePath(): string | undefined {
    return this.rdpFile;
  }

  /**
   * Maps the drive, stores the credential, starts mstsc, then calls `waitForAgent` (which resolves when the agent's
   * heartbeat shows up and rejects when the connect timeout passes). Whatever happens after the credential was
   * stored, it is deleted again in a `finally` - the password sits in the Windows credential store only while mstsc
   * connects. On failure everything this call set up is torn down again.
   */
  async open(waitForAgent: () => Promise<void>): Promise<void> {
    this.assertWindowsWithTools();
    try {
      this.mapDrive();
      try {
        this.storeCredential();
        this.rdpFile = this.writeRdpFile();
        this.startMstsc();
        await waitForAgent();
      } finally {
        this.deleteCredential();
      }
    } catch (error) {
      await this.close({ graceMs: 0 });
      throw error;
    }
  }

  private assertWindowsWithTools(): void {
    const needs = `REMOTE_AGENT_START=alternate-shell needs Windows with ${RDP_TOOLS.join(', ')}`;
    if (this.runner.platform !== 'win32')
      throw new RemoteError(
        'UNSUPPORTED_PLATFORM',
        `${needs}, but this machine is ${this.runner.platform}. Run the tests on the Windows test machine, or use REMOTE_AGENT_START=startup|manual and open the RDP session yourself (automation-remote setup-help).`,
        { operation: 'open rdp' },
      );
    const missing = RDP_TOOLS.filter((tool) => !this.runner.exists(tool));
    if (missing.length > 0)
      throw new RemoteError('UNSUPPORTED_PLATFORM', `${needs}; not found on the PATH: ${missing.join(', ')}`, { operation: 'open rdp' });
  }

  private run(command: string, args: string[]): CommandResult {
    const shown = `${command} ${maskCommandLine(args).join(' ')}`;
    this.log.debug(`run ${shown}`);
    const result = this.runner.run(command, args);
    if (result.error || result.status !== 0)
      this.log.debug(`${command} exited ${result.status}${result.error ? ` (${result.error})` : ''}`);
    return result;
  }

  private scrub(text: string): string {
    const password = this.config.password;
    return (password ? text.split(password).join('********') : text).trim();
  }

  private mapDrive(): void {
    const letter = this.config.driveLetter;
    const listed = this.run('subst', []);
    const mapped = parseSubstList(listed.stdout, letter);
    if (mapped !== undefined) {
      if (!samePath(mapped, this.config.shareDir))
        throw new RemoteError(
          'RDP_LAUNCH_FAILED',
          `drive ${letter}: is already mapped (subst) to ${mapped}, not to the mailbox folder ${this.config.shareDir}. Choose another REMOTE_DRIVE_LETTER, or remove that mapping with "subst ${letter}: /D" if it is a leftover.`,
          { operation: 'subst' },
        );
      this.log.info(`drive ${letter}: already maps to the mailbox folder - reusing it`);
      return;
    }
    if (this.runner.pathExists(`${letter}:\\`))
      throw new RemoteError(
        'RDP_LAUNCH_FAILED',
        `drive ${letter}: is a real drive on this machine; the mailbox needs a spare letter - set REMOTE_DRIVE_LETTER (for example R)`,
        { operation: 'subst' },
      );
    const result = this.run('subst', [`${letter}:`, this.config.shareDir]);
    if (result.error || result.status !== 0)
      throw new RemoteError('RDP_LAUNCH_FAILED', `subst ${letter}: ${this.config.shareDir} failed: ${this.scrub(result.error ?? (result.stderr || result.stdout))}`, { operation: 'subst' });
    this.substCreated = true;
    this.log.info(`drive ${letter}: now maps to ${this.config.shareDir}`);
  }

  private storeCredential(): void {
    const { qualifiedUser, password } = this.config;
    if (!qualifiedUser || !password)
      throw new RemoteError('RDP_LAUNCH_FAILED', 'REMOTE_RDP_USER and REMOTE_RDP_PASSWORD are needed to log in', { operation: 'cmdkey' });
    this.credentialStored = true; // from here on the credential must be deleted again, whatever fails
    const result = this.run('cmdkey', [`/generic:${this.credentialTarget}`, `/user:${qualifiedUser}`, `/pass:${password}`]);
    if (result.error || result.status !== 0)
      throw new RemoteError('RDP_LAUNCH_FAILED', `cmdkey could not store the login for ${this.credentialTarget}: ${this.scrub(result.error ?? (result.stderr || result.stdout))}`, { operation: 'cmdkey' });
  }

  private deleteCredential(): void {
    if (!this.credentialStored) return;
    this.credentialStored = false;
    const result = this.run('cmdkey', [`/delete:${this.credentialTarget}`]);
    if (result.error || result.status !== 0)
      this.log.warn(`could not delete the stored login ${this.credentialTarget} (cmdkey /delete:${this.credentialTarget}) - delete it by hand: ${this.scrub(result.error ?? result.stderr)}`);
  }

  private writeRdpFile(): string {
    const dir = this.options.tempDir ?? os.tmpdir();
    const file = path.join(dir, `automation-remote-${randomBytes(4).toString('hex')}.rdp`);
    fs.writeFileSync(file, buildRdpFile(this.config));
    return file;
  }

  private startMstsc(): void {
    try {
      this.child = this.runner.launch('mstsc', [this.rdpFile as string]);
    } catch (error) {
      throw new RemoteError('RDP_LAUNCH_FAILED', `could not start mstsc: ${this.scrub(error instanceof Error ? error.message : String(error))}`, { operation: 'mstsc', cause: error });
    }
    this.child.onExit((code) => {
      this.childExit = { code };
      this.log.info(`mstsc ended (exit code ${code})`);
    });
    this.log.info(`mstsc started for ${this.config.host}:${this.config.port} (pid ${this.child.pid ?? '?'}, RDP file ${this.rdpFile})`);
  }

  /** Lets go of mstsc and the drive without closing them: the session stays open for the next run / other workers. */
  detach(): void {
    this.child?.unref();
    this.child = undefined;
    this.substCreated = false; // the mapping must stay as long as the session runs
    this.removeRdpFile();
  }

  private removeRdpFile(): void {
    if (this.rdpFile) fs.rmSync(this.rdpFile, { force: true });
    this.rdpFile = undefined;
  }

  /**
   * Ends our mstsc (after `graceMs` for it to close by itself - the agent's shutdown request ends the session),
   * removes the drive mapping if THIS session created it, and makes sure no credential is left stored.
   */
  async close(options: { graceMs?: number } = {}): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) {
      const deadline = Date.now() + (options.graceMs ?? 5000);
      while (!child.hasExited() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!child.hasExited()) child.kill();
    }
    this.deleteCredential();
    if (this.substCreated) {
      this.substCreated = false;
      const result = this.run('subst', [`${this.config.driveLetter}:`, '/D']);
      if (result.error || result.status !== 0) this.log.warn(`could not remove drive ${this.config.driveLetter}: - run "subst ${this.config.driveLetter}: /D" yourself`);
    }
    this.removeRdpFile();
  }

  /** Removes the drive mapping if it points at the mailbox folder (for `automation-remote close` from another process). */
  static releaseDrive(config: RemoteConfig, runner: CommandRunner = createCommandRunner()): boolean {
    if (runner.platform !== 'win32') return false;
    const mapped = parseSubstList(runner.run('subst', []).stdout, config.driveLetter);
    if (mapped === undefined || !samePath(mapped, config.shareDir)) return false;
    return runner.run('subst', [`${config.driveLetter}:`, '/D']).status === 0;
  }
}
