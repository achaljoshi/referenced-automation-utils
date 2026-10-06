import Client from 'ssh2-sftp-client';
import { adapterStep, type Adapter } from '../adapters/adapter';

export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  readyTimeout?: number;
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

  async connect(config: SftpConfig): Promise<void> {
    // Host/port/user only - never the password/privateKey.
    await adapterStep(this.name, 'connect', () => this.client.connect(config), {
      details: { host: config.host, port: config.port ?? 22, username: config.username },
    });
    this.connected = true;
  }

  /** True once connect() has succeeded and until close() - a cheap, side-effect-free check. */
  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  /** Uploads a local file to a remote path. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    await adapterStep(this.name, 'upload', () => this.client.put(localPath, remotePath), {
      details: { localPath, remotePath },
    });
  }

  /** Downloads a remote file to a local path. */
  async download(remotePath: string, localPath: string): Promise<void> {
    await adapterStep(this.name, 'download', () => this.client.get(remotePath, localPath), {
      details: { remotePath, localPath },
    });
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

  async rmdir(remoteDir: string, recursive = true): Promise<void> {
    await adapterStep(this.name, 'rmdir', () => this.client.rmdir(remoteDir, recursive), { details: { remoteDir, recursive } });
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await adapterStep(this.name, 'close', () => this.client.end());
    this.connected = false;
  }
}
