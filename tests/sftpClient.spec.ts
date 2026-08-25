import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SftpClient } from '../src/transfer/sftpClient';
import { startSftpTestServer, stopSftpTestServer, type SftpTestServerHandle } from './support/sftpTestServer';

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
    expect(byName['one.txt'].type).toBe('-');
    expect(byName['two.txt'].size).toBe(2);
  });

  test('delete() removes a real file from disk', async () => {
    await client.delete('/report.csv');
    expect(fs.existsSync(path.join(server.root, 'report.csv'))).toBe(false);
  });

  test('rmdir() removes a real directory (and its contents) from disk', async () => {
    await client.rmdir('/a-directory');
    expect(fs.existsSync(path.join(server.root, 'a-directory'))).toBe(false);
  });

  test('mkdir() creates nested directories in one call', async () => {
    await client.mkdir('/nested/child/grandchild');
    expect(fs.existsSync(path.join(server.root, 'nested', 'child', 'grandchild'))).toBe(true);
  });
});
