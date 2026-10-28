import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import Client from 'ssh2-sftp-client';
import { adapterStep, type Adapter } from '../adapters/adapter';
import { getLogger } from '../logger/logger';

export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  readyTimeout?: number;
  /**
   * The server's host key fingerprint, as OpenSSH prints it (`SHA256:<base64>`, from `ssh-keygen -lf` or
   * `ssh-keyscan host | ssh-keygen -lf -`) or as 64 hex characters. When set, a connection to a server presenting any
   * other key is refused BEFORE credentials are sent - without it a man in the middle receives the password.
   */
  hostFingerprint?: string;
  /** Your own check of the raw host key (return true to accept). Applied in addition to `hostFingerprint`. */
  hostVerifier?: (hostKey: Buffer) => boolean;
}

/** `SHA256:<base64, unpadded>` of an SSH host key blob - the form `ssh-keygen -l` prints. */
export function hostKeyFingerprint(hostKey: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

function sameFingerprint(expected: string, hostKey: Buffer): boolean {
  const wanted = expected.trim();
  const sha256 = crypto.createHash('sha256').update(hostKey).digest();
  const given = /^sha256:/i.test(wanted)
    ? Buffer.from(wanted.slice(7).replace(/=+$/, ''), 'base64')
    : Buffer.from(wanted.replace(/:/g, ''), 'hex'); // hex, with or without colons
  return given.length === sha256.length && crypto.timingSafeEqual(given, sha256);
}

export interface SftpFileInfo {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
}

/**
 * A pure Node.js SFTP client for automated file transfer - the same job
 * WinSCP does interactively (connect, upload, download, list, delete),
 * but scriptable and identical across a Windows machine, local macOS/Linux
 * dev, and a GitLab CI Linux runner, with no external WinSCP install
 * anywhere in the chain. Connection details are supplied by the caller at
 * connect() time, same as every other client in this framework - this
 * class never reads env vars or stores real credentials itself; the
 * consuming repo's own .env.<name> file is where those belong.
 *
 * ```ts
 * const env = loadEnv();
 * const sftp = new SftpClient();
 * await sftp.connect({
 *   host: env.get('SFTP_HOST'),
 *   username: env.get('SFTP_USER'),
 *   password: env.get('SFTP_PASSWORD'),
 * });
 * await sftp.upload('./report.csv', '/incoming/report.csv');
 * const files = await sftp.list('/incoming');
 * await sftp.close();
 * ```
 */
export class SftpClient implements Adapter {
  readonly name = 'sftp';
  private readonly client = new Client();
  private connected = false;

  constructor() {
    // The connection can die under us (server restart, network drop): track it, so healthCheck() tells the truth.
    const dropped = () => {
      this.connected = false;
    };
    this.client.on('close', dropped);
    this.client.on('end', dropped);
    this.client.on('error', dropped);
  }

  async connect(config: SftpConfig): Promise<void> {
    // A second connect() on the same client would orphan the first connection (and its socket): end that one first.
    if (this.connected) await this.close();
    const { hostFingerprint, hostVerifier, ...ssh } = config;
    const sshConfig: Record<string, unknown> = { ...ssh };
    if (hostFingerprint !== undefined || hostVerifier) {
      sshConfig.hostVerifier = (hostKey: Buffer) =>
        (hostFingerprint === undefined || sameFingerprint(hostFingerprint, hostKey)) &&
        (!hostVerifier || hostVerifier(hostKey));
    } else {
      getLogger(this.name).warn(
        `connecting to ${config.host} without host key verification - set hostFingerprint to refuse an impostor server`,
      );
    }
    // Host/port/user only - never the password/privateKey.
    await adapterStep(this.name, 'connect', () => this.client.connect(sshConfig as never), {
      details: { host: config.host, port: config.port ?? 22, username: config.username },
    });
    this.connected = true;
  }

  /**
   * True while the connection is alive: false before connect(), after close(), and once the server or network has
   * dropped it (the client's 'close' / 'end' / 'error' events), confirmed by a round trip to the server.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.connected) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.cwd(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('no answer from the SFTP server')), 5000);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Uploads a local file to a remote path. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    await adapterStep(this.name, 'upload', () => this.client.put(localPath, remotePath), {
      details: { localPath, remotePath },
    });
  }

  /**
   * Downloads a remote file to a local path. Returns once the whole file is on disk: the local file is complete and
   * closed, so reading it at once sees every byte. On a failure no partial file is left behind.
   *
   * (`ssh2-sftp-client` itself resolves `get(remote, localPath)` when the remote side has been read, which can be before
   * the local write stream has flushed. This writes through a stream of its own and waits for it to close.)
   */
  async download(remotePath: string, localPath: string): Promise<void> {
    await adapterStep(
      this.name,
      'download',
      async () => {
        const out = fs.createWriteStream(localPath);
        const closed = new Promise<void>((resolve, reject) => {
          out.once('close', resolve);
          out.once('error', reject);
        });
        // Nobody awaits `closed` while get() is still running; a write error then belongs to get() (it listens too).
        closed.catch(() => undefined);
        try {
          await this.client.get(remotePath, out);
          await closed;
        } catch (error) {
          out.destroy();
          await fs.promises.rm(localPath, { force: true });
          throw error;
        }
      },
      { details: { remotePath, localPath } },
    );
  }

  async list(remoteDir: string): Promise<SftpFileInfo[]> {
    const entries = await adapterStep(this.name, 'list', () => this.client.list(remoteDir), {
      level: 'debug',
      details: { remoteDir },
    });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.type as SftpFileInfo['type'],
      size: entry.size,
      modifyTime: entry.modifyTime,
    }));
  }

  async exists(remotePath: string): Promise<false | 'd' | '-' | 'l'> {
    return adapterStep(this.name, 'exists', () => this.client.exists(remotePath), {
      level: 'debug',
      details: { remotePath },
    });
  }

  async delete(remotePath: string): Promise<void> {
    await adapterStep(this.name, 'delete', () => this.client.delete(remotePath), { details: { remotePath } });
  }

  async mkdir(remoteDir: string, recursive = true): Promise<void> {
    await adapterStep(this.name, 'mkdir', () => this.client.mkdir(remoteDir, recursive), { details: { remoteDir, recursive } });
  }

  /** Removes a directory. Empty ones only by default; pass `recursive: true` to delete its contents too (explicitly - it cannot be undone). */
  async rmdir(remoteDir: string, recursive = false): Promise<void> {
    await adapterStep(this.name, 'rmdir', () => this.client.rmdir(remoteDir, recursive), { details: { remoteDir, recursive } });
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await adapterStep(this.name, 'close', () => this.client.end());
  }
}
