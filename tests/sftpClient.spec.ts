import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AdapterError } from '../src/adapters/adapter';
import { SftpClient, hostKeyFingerprint } from '../src/transfer/sftpClient';
import { startSftpTestServer, stopSftpTestServer, type SftpTestServerHandle } from '../src/testing';

let server: SftpTestServerHandle;
let client: SftpClient;
let localDir: string;

test.beforeAll(async () => {
  server = await startSftpTestServer();
  client = new SftpClient();
  await client.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password,
  });
  localDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-client-test-'));
});

test.afterAll(async () => {
  await client.close();
  await stopSftpTestServer(server);
  await fs.promises.rm(localDir, { recursive: true, force: true });
});

test.describe('SftpClient @smoke', () => {
  // Each test builds on filesystem state the previous one left behind
  // (upload before delete, mkdir before list, etc.) against one shared
  // connection - fullyParallel's default per-test parallelism would race
  // these against each other, so this suite opts into serial order.
  test.describe.configure({ mode: 'serial' });

  test('upload() writes a real file the server can read back from disk', async () => {
    const localPath = path.join(localDir, 'report.csv');
    await fs.promises.writeFile(localPath, 'id,name\n1,Ada\n2,Grace\n');

    await client.upload(localPath, '/report.csv');

    const onDisk = await fs.promises.readFile(path.join(server.root, 'report.csv'), 'utf-8');
    expect(onDisk).toBe('id,name\n1,Ada\n2,Grace\n');
  });

  test('download() retrieves a file the server actually has on disk', async () => {
    await fs.promises.writeFile(path.join(server.root, 'downloaded.txt'), 'server-side content');

    const localPath = path.join(localDir, 'downloaded.txt');
    await client.download('/downloaded.txt', localPath);

    expect(await fs.promises.readFile(localPath, 'utf-8')).toBe('server-side content');
  });

  test('exists() reflects real file/dir state on the server', async () => {
    expect(await client.exists('/report.csv')).toBe('-');
    expect(await client.exists('/does-not-exist.txt')).toBe(false);

    await client.mkdir('/a-directory');
    expect(await client.exists('/a-directory')).toBe('d');
  });

  test('list() enumerates real directory contents', async () => {
    await fs.promises.writeFile(path.join(server.root, 'a-directory', 'one.txt'), '1');
    await fs.promises.writeFile(path.join(server.root, 'a-directory', 'two.txt'), '22');

    const entries = await client.list('/a-directory');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

    expect(Object.keys(byName).sort()).toEqual(['one.txt', 'two.txt']);
    expect(byName['one.txt']?.type).toBe('-');
    expect(byName['two.txt']?.size).toBe(2);
  });

  test('delete() removes a real file from disk', async () => {
    await client.delete('/report.csv');
    expect(fs.existsSync(path.join(server.root, 'report.csv'))).toBe(false);
  });

  test('rmdir() refuses a non-empty directory by default - nothing is deleted - and deletes it only with recursive: true', async () => {
    await expect(client.rmdir('/a-directory')).rejects.toThrow(/rmdir/);
    expect(fs.existsSync(path.join(server.root, 'a-directory', 'one.txt'))).toBe(true);

    await client.rmdir('/a-directory', true);
    expect(fs.existsSync(path.join(server.root, 'a-directory'))).toBe(false);
  });

  test('rmdir() removes an empty directory by default', async () => {
    await client.mkdir('/empty-dir');
    await client.rmdir('/empty-dir');
    expect(fs.existsSync(path.join(server.root, 'empty-dir'))).toBe(false);
  });

  test('mkdir() creates nested directories in one call', async () => {
    await client.mkdir('/nested/child/grandchild');
    expect(fs.existsSync(path.join(server.root, 'nested', 'child', 'grandchild'))).toBe(true);
  });
});

const login = (handle: SftpTestServerHandle) => ({ host: handle.host, port: handle.port, username: handle.username, password: handle.password });

test.describe('SftpClient host key verification', () => {
  test('connects when hostFingerprint matches the server key (OpenSSH form and hex form)', async () => {
    const hex = Buffer.from(server.fingerprint.slice(7), 'base64').toString('hex');
    for (const hostFingerprint of [server.fingerprint, hex, hex.replace(/(..)(?!$)/g, '$1:')]) {
      const sftp = new SftpClient();
      await sftp.connect({ ...login(server), hostFingerprint });
      expect(await sftp.healthCheck()).toBe(true);
      await sftp.close();
    }
  });

  test('refuses a server whose key is not the pinned one, before the password is offered', async () => {
    const impostor = new SftpClient();
    const wrong = 'SHA256:' + Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
    const error = await impostor.connect({ ...login(server), hostFingerprint: wrong }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(await impostor.healthCheck()).toBe(false);
    // and the real server saw no authenticated session from it: the client is simply not connected
    await expect(impostor.list('/')).rejects.toThrow();
  });

  test('a custom hostVerifier decides too, and receives the raw host key', async () => {
    let seen: Buffer | undefined;
    const accepting = new SftpClient();
    await accepting.connect({ ...login(server), hostVerifier: (key) => ((seen = key), true) });
    expect(seen && hostKeyFingerprint(seen)).toBe(server.fingerprint);
    await accepting.close();

    const rejecting = new SftpClient();
    await expect(rejecting.connect({ ...login(server), hostVerifier: () => false })).rejects.toThrow();
    // both checks must pass: a right fingerprint does not override a verifier that says no
    await expect(rejecting.connect({ ...login(server), hostFingerprint: server.fingerprint, hostVerifier: () => false })).rejects.toThrow();
  });
});

test.describe('SftpClient connection state', () => {
  test('healthCheck is false before connect, true while connected, false after close', async () => {
    const sftp = new SftpClient();
    expect(await sftp.healthCheck()).toBe(false);
    await sftp.connect(login(server));
    expect(await sftp.healthCheck()).toBe(true);
    await sftp.close();
    expect(await sftp.healthCheck()).toBe(false);
  });

  test('healthCheck turns false when the server drops the connection', async () => {
    const own = await startSftpTestServer();
    const sftp = new SftpClient();
    try {
      await sftp.connect(login(own));
      expect(await sftp.healthCheck()).toBe(true);
      own.dropConnections();
      await expect.poll(() => sftp.healthCheck(), { timeout: 5000 }).toBe(false);
    } finally {
      await sftp.close();
      await stopSftpTestServer(own);
    }
  });

  test('a second connect() while connected replaces the first connection instead of leaking it', async () => {
    const own = await startSftpTestServer();
    const sftp = new SftpClient();
    const open = () => new Promise<number>((resolve) => setTimeout(() => resolve(own.openConnections()), 100));
    try {
      await sftp.connect(login(own));
      await sftp.connect(login(own));
      expect(await sftp.healthCheck()).toBe(true);
      expect(await open()).toBe(1); // the first connection was ended, not orphaned
      await sftp.close();
      expect(await open()).toBe(0);
    } finally {
      await sftp.close();
      await stopSftpTestServer(own);
    }
  });
});
