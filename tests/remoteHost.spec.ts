import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { withCorrelationId } from '../src/logger/correlation';
import { bodyText, decodeBody, encodeBody } from '../src/remote/protocol';
import { RemoteDbClient } from '../src/remote/remoteDb';
import { RemoteError, RemoteHost, closeRemoteHost, getRemoteHost } from '../src/remote/remoteHost';
import { StandInAgent } from './support/standInAgent';
import { FakeRunner, captureStdout, reader, startHttpServer, startRig, cleanTmpDirs, testConfig, tmpDir, type Rig } from './support/remoteFixtures';

/** Runs a test body with a started stand-in agent and a connected host, and always cleans up. */
async function withRig(options: Parameters<typeof startRig>[0], body: (rig: Rig) => Promise<void>): Promise<void>;
async function withRig(body: (rig: Rig) => Promise<void>): Promise<void>;
async function withRig(a: Parameters<typeof startRig>[0] | ((rig: Rig) => Promise<void>), b?: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await startRig(typeof a === 'function' ? {} : a);
  try {
    await (typeof a === 'function' ? a : (b as (rig: Rig) => Promise<void>))(rig);
  } finally {
    await rig.cleanup();
  }
}

test.afterAll(cleanTmpDirs);

const DB = { provider: 'sqlite-stand-in', connectionString: ':memory:' };
const files = (dir: string) => fs.readdirSync(dir);

test.describe('ping and the agent identity', () => {
  test('ping returns who the agent is', async () => {
    await withRig(async ({ host }) => {
      const ping = await host.ping();
      expect(ping).toMatchObject({ host: 'STAND-IN-HOST', interactive: true, agentVersion: '1.0.0', sessionId: 2 });
      expect(ping.pid).toBe(process.pid);
    });
  });

  test('request() connects by itself when nobody called connect()', async () => {
    const rig = await startRig({ connect: false });
    try {
      expect((await rig.host.ping()).host).toBe('STAND-IN-HOST');
    } finally {
      await rig.cleanup();
    }
  });

  test('the test correlation id travels with the request (ADR 0004)', async () => {
    await withRig(async ({ host, agent }) => {
      await withCorrelationId('cid-12345678', () => host.ping());
      await host.ping();
      expect(agent.correlationIds).toEqual(['cid-12345678', undefined]);
    });
  });
});

test.describe('http from the remote host', () => {
  test('a GET and a POST reach a real server with their headers and body; the answer comes back complete', async () => {
    const server = await startHttpServer();
    try {
      await withRig(async ({ host }) => {
        const get = await host.http({ method: 'GET', url: `${server.url}/echo?a=1`, headers: { 'X-Token': 'abc', Accept: 'application/json' } });
        expect(get.status).toBe(200);
        expect(get.headers['x-reply']).toBe('from-test-server');
        expect(get.headers['content-type']).toContain('application/json');
        const echoed = JSON.parse(bodyText(get)) as { method: string; headers: Record<string, string> };
        expect(echoed.method).toBe('GET');
        expect(echoed.headers['x-token']).toBe('abc');
        expect(get.durationMs).toBeGreaterThanOrEqual(0);

        const payload = '{"name":"Zoë","n":1}';
        const post = await host.http({ method: 'POST', url: `${server.url}/echo`, headers: { 'Content-Type': 'application/json' }, bodyBase64: encodeBody(payload) });
        expect((JSON.parse(bodyText(post)) as { body: string }).body).toBe(payload);
        expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /echo?a=1', 'POST /echo']);
        expect(decodeBody(post).length).toBeGreaterThan(payload.length);
      });
    } finally {
      await server.close();
    }
  });

  test('redirects are NOT followed by default (the 302 is the answer) and are followed on request', async () => {
    const server = await startHttpServer();
    try {
      await withRig(async ({ host }) => {
        const off = await host.http({ method: 'GET', url: `${server.url}/redirect` });
        expect(off.status).toBe(302);
        expect(off.headers.location).toBe('/echo');
        const on = await host.http({ method: 'GET', url: `${server.url}/redirect`, followRedirects: true });
        expect(on.status).toBe(200);
        expect(on.url).toBe(`${server.url}/echo`);
      });
    } finally {
      await server.close();
    }
  });

  test('an unreachable URL is a REMOTE_ERROR carrying the reason; a slow one hits the agent-side timeout', async () => {
    const server = await startHttpServer();
    try {
      await withRig(async ({ host }) => {
        const refused = (await host.http({ method: 'GET', url: 'http://127.0.0.1:1/x' }).catch((e: unknown) => e)) as RemoteError;
        expect(refused).toBeInstanceOf(RemoteError);
        expect(refused.code).toBe('REMOTE_ERROR');
        const slow = (await host.http({ method: 'GET', url: `${server.url}/slow`, timeoutMs: 150 }).catch((e: unknown) => e)) as RemoteError;
        expect(slow.code).toBe('TIMEOUT');
        expect(slow.message).toContain('150 ms');
      });
    } finally {
      await server.close();
    }
  });

  test('is refused before anything is sent when http is not in REMOTE_ALLOW', async () => {
    await withRig({ config: { allow: ['db'] } }, async ({ host, agent }) => {
      const error = (await host.http({ method: 'GET', url: 'http://127.0.0.1:1/' }).catch((e: unknown) => e)) as RemoteError;
      expect(error.code).toBe('DENIED');
      expect(error.message).toContain('REMOTE_ALLOW does not include "http"');
      expect(agent.processed).not.toContain('http');
    });
  });
});

test.describe('database through the host', () => {
  test('update and query with parameters, a row cap, and NULL / binary values', async () => {
    await withRig({ config: { dbProvider: DB.provider, dbConnectionString: DB.connectionString } }, async ({ host }) => {
      expect((await host.dbUpdate('CREATE TABLE t (id INTEGER, name TEXT, data BLOB)')).rowCount).toBe(0);
      expect((await host.dbUpdate('INSERT INTO t VALUES (?, ?, ?)', [1, 'Ada', Buffer.from('hi').toString('base64')])).rowCount).toBe(1);
      for (const [id, name] of [[2, 'Grace'], [3, null], [4, 'Linus']]) await host.dbUpdate('INSERT INTO t (id, name) VALUES (?, ?)', [id, name]);
      expect((await host.dbUpdate('UPDATE t SET name = ? WHERE id >= ?', ['x', 3])).rowCount).toBe(2);

      const one = await host.dbQuery('SELECT id, name FROM t WHERE id = ?', [2]);
      expect(one).toEqual({ rows: [{ id: 2, name: 'Grace' }], rowCount: 1, truncated: false });
      const capped = await host.dbQuery('SELECT id FROM t ORDER BY id', [], { maxRows: 2 });
      expect(capped.rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(capped).toMatchObject({ rowCount: 2, truncated: true });
      const nulls = await host.dbQuery('SELECT name FROM t WHERE id = ?', [1]);
      expect(nulls.rows).toEqual([{ name: 'Ada' }]);
    });
  });

  test('a SQL error is a REMOTE_ERROR with the database message; a missing provider / connection string is explained', async () => {
    await withRig(async ({ host }) => {
      const bad = (await host.dbQuery('SELEC 1', [], DB).catch((e: unknown) => e)) as RemoteError;
      expect(bad.code).toBe('REMOTE_ERROR');
      expect(bad.message).toMatch(/syntax error/i);
      await expect(host.dbQuery('SELECT 1')).rejects.toThrow(/REMOTE_DB_PROVIDER/);
      await expect(host.dbQuery('SELECT 1', [], { provider: 'p' })).rejects.toThrow(/REMOTE_DB_CONNECTION_STRING/);
    });
  });

  test('a large parameter makes the round trip intact', async () => {
    await withRig(async ({ host }) => {
      const big = 'é'.repeat(300_000);
      const result = await host.dbQuery('SELECT ? AS big', [big], DB);
      expect((result.rows[0] as { big: string }).big).toBe(big);
    });
  });

  test('RemoteDbClient is a DbClient: query, queryScalar, update, healthCheck; provider and connection string come from the config', async () => {
    await withRig({ config: { dbProvider: DB.provider, dbConnectionString: DB.connectionString } }, async ({ host }) => {
      const db = new RemoteDbClient(host);
      expect(await db.healthCheck()).toBe(true);
      await db.update('CREATE TABLE p (id INTEGER, label TEXT)');
      expect(await db.update('INSERT INTO p VALUES (?, ?), (?, ?)', [1, 'a', 2, 'b'])).toBe(2);
      expect(await db.query<{ id: number; label: string }>('SELECT * FROM p ORDER BY id')).toEqual([{ id: 1, label: 'a' }, { id: 2, label: 'b' }]);
      expect(await db.queryScalar<number>('SELECT COUNT(*) FROM p')).toBe(2);
      await expect(db.queryScalar('SELECT id FROM p WHERE id = 99')).rejects.toThrow(/found no rows/);
      await db.close(); // does not close the shared host
      expect((await host.ping()).host).toBe('STAND-IN-HOST');
    });
  });

  test('is refused (DENIED) when db is not allowed', async () => {
    await withRig({ config: { allow: ['http'] } }, async ({ host }) => {
      await expect(host.dbQuery('SELECT 1', [], DB)).rejects.toMatchObject({ code: 'DENIED' });
      await expect(host.dbUpdate('DELETE FROM x', [], DB)).rejects.toMatchObject({ code: 'DENIED' });
    });
  });
});

test.describe('exec and the allow list', () => {
  test('exec is denied by default - on the client, before anything is sent', async () => {
    await withRig(async ({ host, agent }) => {
      const error = (await host.exec({ command: process.execPath, args: ['-v'] }).catch((e: unknown) => e)) as RemoteError;
      expect(error).toBeInstanceOf(RemoteError);
      expect(error.code).toBe('DENIED');
      expect(error.message).toContain('must be listed explicitly');
      expect(agent.processed).not.toContain('exec');
    });
  });

  test('exec runs when it is listed; stdout, stderr, exit code, cwd and env are carried', async () => {
    await withRig({ config: { allow: ['http', 'db', 'sap', 'exec'] } }, async ({ host }) => {
      const ok = await host.exec({ command: process.execPath, args: ['-e', 'console.log("out"); console.error("err"); process.exit(3)'] });
      expect(ok).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
      const env = await host.exec({ command: process.execPath, args: ['-e', 'console.log(process.env.GREETING + ":" + process.cwd())'], env: { GREETING: 'hello' }, cwd: tmpDir() });
      expect(env.stdout).toMatch(/^hello:.*remote-test-/);
      const shell = await host.exec({ command: 'echo', args: ['from-shell'], shell: 'cmd' });
      expect(shell.stdout.trim()).toBe('from-shell');
    });
  });

  test('a command that overruns its timeout is killed and reported as timedOut', async () => {
    await withRig({ config: { allow: ['exec'] } }, async ({ host }) => {
      const result = await host.exec({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 200 });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
    });
  });

  test('the AGENT refuses too: a request that bypasses the client is answered DENIED', async () => {
    await withRig(async ({ host, agent }) => {
      const error = (await host.request('exec', { command: process.execPath, args: ['-v'] }).catch((e: unknown) => e)) as RemoteError;
      expect(error.code).toBe('DENIED');
      expect(error.remoteCode).toBe('DENIED');
      expect(error.message).toContain('not allowed by REMOTE_ALLOW');
      expect(agent.processed).toContain('exec'); // it did reach the agent, which said no
    });
  });

  test('a changed allow list reaches a RUNNING agent (it reloads agent/config.json) when another client connects', async () => {
    await withRig({ config: { allow: ['http', 'db', 'sap'] } }, async ({ shareDir, host, agent }) => {
      await expect(host.request('exec', { command: process.execPath, args: ['-v'] })).rejects.toMatchObject({ code: 'DENIED' });
      const second = new RemoteHost(testConfig(shareDir, { allow: ['http', 'db', 'sap', 'exec'] }));
      await second.connect();
      expect(agent.allow).toEqual(['http', 'db', 'sap', 'exec']);
      const ran = await second.exec({ command: process.execPath, args: ['-e', 'console.log("one")'] });
      expect(ran.stdout).toBe('one\n');
      await second.close();
    });
  });
});

test.describe('failures that must be explained', () => {
  test('TIMEOUT names the request type and the time, and leaves no file behind', async () => {
    await withRig({ agent: { hold: ['db.query'] } }, async ({ host, shareDir, config }) => {
      const error = (await host.request('db.query', { ...DB, sql: 'SELECT 1' }, { timeoutMs: 300 }).catch((e: unknown) => e)) as RemoteError;
      expect(error).toBeInstanceOf(RemoteError);
      expect(error.code).toBe('TIMEOUT');
      expect(error.message).toMatch(/no response to "db\.query" after \d+ms \(limit 300ms\)/);
      expect(error.message).toContain('one request at a time');
      expect(files(path.join(shareDir, 'requests'))).toEqual([]);
      expect(files(path.join(shareDir, 'responses'))).toEqual([]);
      expect(config.requestTimeoutMs).toBe(5000);
    });
  });

  test('AGENT_STALE: an agent that dies while idle is detected by the next request, which does not wait for its timeout', async () => {
    await withRig(async ({ host, agent }) => {
      await host.ping();
      await agent.crash();
      const started = Date.now();
      const error = (await host.ping().catch((e: unknown) => e)) as RemoteError;
      expect(error.code).toBe('AGENT_STALE');
      expect(error.message).toMatch(/no heartbeat for \d+s, limit 1s/);
      expect(error.message).toContain('RDP session was probably closed');
      expect(Date.now() - started).toBeLessThan(4000); // far below the 5 s request timeout
    });
  });

  test('AGENT_STALE: an agent that dies while a request is waiting fails that request fast', async () => {
    await withRig({ agent: { hold: ['ping'] } }, async ({ host, agent, shareDir }) => {
      const pending = host.ping().catch((e: unknown) => e);
      await expect.poll(() => agent.processed.includes('ping')).toBe(true);
      await agent.crash();
      const error = (await pending) as RemoteError;
      expect(error.code).toBe('AGENT_STALE');
      expect(files(path.join(shareDir, 'requests'))).toEqual([]); // the waiting request is withdrawn
    });
  });

  test('AGENT_STALE when the agent exits cleanly (its heartbeat file is gone)', async () => {
    await withRig(async ({ host, agent }) => {
      await agent.stop();
      const error = (await host.ping().catch((e: unknown) => e)) as RemoteError;
      expect(error.code).toBe('AGENT_STALE');
      expect(error.message).toContain('heartbeat file is gone');
    });
  });

  test('AGENT_NOT_STARTED carries the numbered checklist of likely causes', async () => {
    const share = tmpDir();
    const host = new RemoteHost(testConfig(share, { connectTimeoutMs: 300 }));
    const error = (await host.connect().catch((e: unknown) => e)) as RemoteError;
    expect(error).toBeInstanceOf(RemoteError);
    expect(error.code).toBe('AGENT_NOT_STARTED');
    expect(error.message).toContain('no agent heartbeat appeared within 300ms');
    for (const [n, text] of [
      [1, 'RDP login failed'],
      [2, 'GPO "Do not allow drive redirection"'],
      [3, 'ignored "alternate shell"'],
      [4, 'PowerShell is blocked'],
      [5, 'agent started and crashed'],
    ] as const)
      expect(error.message).toMatch(new RegExp(`\\n  ${n}\\. .*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(error.message).toContain(path.join(share, 'agent', 'agent.log'));
    expect(error.message).toContain('it does not exist: the agent never ran');
    await host.close();
  });

  test('AGENT_NOT_STARTED quotes the last lines of agent.log when the agent crashed', async () => {
    const share = tmpDir();
    fs.mkdirSync(path.join(share, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(share, 'agent', 'agent.log'), 'line one\r\nthe agent crashed: boom\r\n');
    const error = (await new RemoteHost(testConfig(share, { connectTimeoutMs: 200 })).connect().catch((e: unknown) => e)) as RemoteError;
    expect(error.message).toContain('the agent crashed: boom');
  });

  test('a failed connect can be retried (the failure is not remembered by the host object)', async () => {
    const share = tmpDir();
    const host = new RemoteHost(testConfig(share, { connectTimeoutMs: 200 }));
    await expect(host.connect()).rejects.toMatchObject({ code: 'AGENT_NOT_STARTED' });
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    await host.connect();
    expect((await host.ping()).host).toBe('STAND-IN-HOST');
    await host.close();
    await agent.stop();
  });

  test('an agent answering with another protocol version is a PROTOCOL error', async () => {
    // A stand-in that is told to hold 'ping' lets the test write the (wrong) answer itself.
    await withRig({ agent: { hold: ['ping'] } }, async ({ host, shareDir }) => {
      const pending = host.request('ping', {}, { timeoutMs: 3000 }).catch((e: unknown) => e);
      await expect.poll(() => files(path.join(shareDir, 'requests')).length).toBe(1);
      const id = path.basename(files(path.join(shareDir, 'requests'))[0] as string, '.json');
      fs.writeFileSync(path.join(shareDir, 'responses', `${id}.json`), JSON.stringify({ v: 99, id, ok: true, result: {}, durationMs: 1 }));
      const error = (await pending) as RemoteError;
      expect(error.code).toBe('PROTOCOL');
      expect(error.message).toContain('protocol version 99');
    });
  });
});

test.describe('concurrency and clean-up', () => {
  test('many requests in flight at once each get their own answer', async () => {
    await withRig(async ({ host }) => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? host.ping().then(() => -1) : host.dbQuery('SELECT ? AS n', [i], DB).then((r) => (r.rows[0] as { n: number }).n))),
      );
      expect(results).toEqual(Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? -1 : i)));
    });
  });

  test('the agent works through requests one at a time, in the order they arrived', async () => {
    await withRig(async ({ host, agent }) => {
      await host.ping();
      agent.processed.length = 0;
      await host.dbQuery('SELECT 1', [], DB);
      await host.ping();
      await host.dbQuery('SELECT 2', [], DB);
      expect(agent.processed).toEqual(['db.query', 'ping', 'db.query']);
    });
  });

  test('no request or response file is left behind - after successes, errors and denials', async () => {
    const server = await startHttpServer();
    try {
      await withRig({ config: { allow: ['http', 'db'] } }, async ({ host, shareDir }) => {
        await host.ping();
        await host.http({ method: 'GET', url: `${server.url}/echo` });
        await host.dbQuery('SELECT 1', [], DB);
        await host.dbQuery('SELEC', [], DB).catch(() => undefined);
        await host.request('exec', { command: 'x' }).catch(() => undefined);
        await host.http({ method: 'GET', url: 'http://127.0.0.1:1/' }).catch(() => undefined);
        expect(files(path.join(shareDir, 'requests'))).toEqual([]);
        expect(files(path.join(shareDir, 'responses'))).toEqual([]);
      });
    } finally {
      await server.close();
    }
  });

  test('the heartbeat is replaced atomically: a reader polling it flat out never sees a torn file', async () => {
    await withRig({ agent: { heartbeatMs: 2 } }, async ({ shareDir }) => {
      const file = path.join(shareDir, 'agent', 'heartbeat.json');
      let reads = 0;
      let torn = 0;
      const until = Date.now() + 700;
      while (Date.now() < until) {
        try {
          JSON.parse(fs.readFileSync(file, 'utf8'));
          reads++;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') torn++;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(reads).toBeGreaterThan(50);
      expect(torn).toBe(0);
    });
  });

  test('requests left by a crashed run are removed at connect, not executed by the next agent', async () => {
    const share = tmpDir();
    fs.mkdirSync(path.join(share, 'requests'), { recursive: true });
    fs.mkdirSync(path.join(share, 'responses'), { recursive: true });
    fs.writeFileSync(path.join(share, 'requests', 'left-over.json'), JSON.stringify({ v: 1, id: 'left-over', type: 'ping', payload: {}, timeoutMs: 1, createdAt: '' }));
    fs.writeFileSync(path.join(share, 'responses', 'orphan.json'), '{}');
    const host = new RemoteHost(testConfig(share));
    const agent = new StandInAgent({ shareDir: share });
    const connecting = host.connect();
    await expect.poll(() => files(path.join(share, 'requests')).length + files(path.join(share, 'responses')).length).toBe(0);
    await agent.start();
    await connecting;
    expect(agent.processed).toEqual([]);
    await host.close();
    await agent.stop();
  });

  test('the agent drops requests older than its limit without answering them', async () => {
    await withRig({ agent: { maxRequestAgeMs: 300 } }, async ({ shareDir, agent }) => {
      const stale = path.join(shareDir, 'requests', 'stale-1.json');
      fs.writeFileSync(stale, JSON.stringify({ v: 1, id: 'stale-1', type: 'ping', payload: {}, timeoutMs: 1, createdAt: '' }));
      const old = new Date(Date.now() - 5000);
      fs.utimesSync(stale, old, old);
      await expect.poll(() => fs.existsSync(stale)).toBe(false);
      expect(files(path.join(shareDir, 'responses'))).toEqual([]);
      expect(agent.processed).toEqual([]);
    });
  });
});

test.describe('processes with a line protocol', () => {
  const echoUpper = `require('readline').createInterface({ input: process.stdin }).on('line', (l) => console.log(l.toUpperCase()));`;

  test('start, send lines, get the next line back, stop', async () => {
    await withRig(async ({ host, agent }) => {
      const proc = await host.startProcess({ scriptText: echoUpper });
      expect(await proc.send('hello')).toBe('HELLO');
      expect(await proc.send('two words')).toBe('TWO WORDS');
      expect(await Promise.all([proc.send('a'), proc.send('b')])).toHaveLength(2);
      await proc.stop();
      await proc.stop(); // idempotent
      await expect(host.request('proc.send', { id: proc.id, line: 'x', timeoutMs: 100 })).rejects.toMatchObject({ remoteCode: 'NOT_FOUND' });
      expect(agent.processed.filter((t) => t === 'proc.stop')).toHaveLength(1);
    });
  });

  test('a file on the host can be run instead of a script text, with arguments', async () => {
    const script = path.join(tmpDir(), 'bridge.js');
    fs.writeFileSync(script, `require('readline').createInterface({ input: process.stdin }).on('line', (l) => console.log(process.argv[2] + ':' + l));`);
    await withRig(async ({ host }) => {
      const proc = await host.startProcess({ file: script, args: ['prefix'] });
      expect(await proc.send('x')).toBe('prefix:x');
      await proc.stop();
      await expect(host.startProcess({ file: path.join(tmpDir(), 'missing.js') })).rejects.toMatchObject({ remoteCode: 'NOT_FOUND' });
    });
  });

  test('a process that does not answer in time is stopped and the call is a TIMEOUT', async () => {
    await withRig(async ({ host }) => {
      const proc = await host.startProcess({ scriptText: `setInterval(() => {}, 1000); process.stdin.resume();` });
      const error = (await proc.send('hello', 200).catch((e: unknown) => e)) as RemoteError;
      expect(error.code).toBe('TIMEOUT');
      expect(error.message).toContain('the process was stopped');
      await expect(host.request('proc.send', { id: proc.id, line: 'again', timeoutMs: 100 })).rejects.toMatchObject({ remoteCode: 'NOT_FOUND' });
    });
  });

  test('a process that exits without answering is a REMOTE_ERROR', async () => {
    await withRig(async ({ host }) => {
      const proc = await host.startProcess({ scriptText: `process.stdin.once('data', () => process.exit(0));` });
      const error = (await proc.send('bye', 3000).catch((e: unknown) => e)) as RemoteError;
      expect(error.code).toBe('REMOTE_ERROR');
      expect(error.message).toContain('ended without answering');
    });
  });

  test('a line with a line break is refused; startProcess needs exactly one of scriptText / file; sap must be allowed', async () => {
    await withRig(async ({ host }) => {
      const proc = await host.startProcess({ scriptText: echoUpper });
      await expect(proc.send('a\nb')).rejects.toThrow(/must not contain line breaks/);
      await proc.stop();
      await expect(host.startProcess({})).rejects.toThrow(/exactly one of scriptText or file/);
      await expect(host.startProcess({ scriptText: 'x', file: 'y' })).rejects.toThrow(/exactly one/);
    });
    await withRig({ config: { allow: ['http'] } }, async ({ host }) => {
      await expect(host.startProcess({ scriptText: echoUpper })).rejects.toMatchObject({ code: 'DENIED' });
    });
  });

  test('close() stops the processes that are still running', async () => {
    const rig = await startRig();
    try {
      await rig.host.startProcess({ scriptText: echoUpper });
      await rig.host.close();
      expect(rig.agent.processed).toContain('proc.stop');
    } finally {
      await rig.cleanup();
    }
  });
});

test.describe('connect, reuse and close', () => {
  test('connect() is idempotent: concurrent calls share one connect, the agent files and config are written, one client is registered', async () => {
    const rig = await startRig({ connect: false });
    try {
      await Promise.all([rig.host.connect(), rig.host.connect(), rig.host.connect()]);
      await rig.host.connect();
      for (const f of ['remote-agent.ps1', 'start.cmd']) expect(fs.existsSync(path.join(rig.shareDir, 'agent', f))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(rig.shareDir, 'agent', 'config.json'), 'utf8'))).toEqual({ allow: ['http', 'db', 'sap'], pollMs: 20, heartbeatMs: 100 });
      expect(files(path.join(rig.shareDir, 'agent', 'clients'))).toHaveLength(1);
    } finally {
      await rig.cleanup();
    }
  });

  test('an agent that is already running is reused: no RDP is started, nothing is purged, its version mismatch is only warned about', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share, agentVersion: '0.9.0' });
    await agent.start();
    const runner = new FakeRunner();
    const host = new RemoteHost(testConfig(share, { agentStart: 'alternate-shell', user: 'u', password: 'p' }), { runner });
    const { error, output } = await captureStdout(() => host.connect());
    expect(error).toBeUndefined();
    expect(runner.calls).toEqual([]); // not even a subst
    expect(output).toContain('reusing the running agent');
    expect(output).toContain('running agent is version 0.9.0');
    expect((await host.ping()).agentVersion).toBe('0.9.0');
    await host.close({ keepOpen: true });
    expect(agent.processed).not.toContain('shutdown');
    await agent.stop();
  });

  test('manual / startup mode waits for the user and says what to do while waiting', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    const host = new RemoteHost(testConfig(share, { agentStart: 'startup', driveLetter: 'Q' }));
    const { error, output } = await captureStdout(async () => {
      const connecting = host.connect();
      await expect.poll(() => fs.existsSync(path.join(share, 'agent', 'config.json'))).toBe(true);
      await agent.start();
      await connecting;
    });
    expect(error).toBeUndefined();
    expect(output).toContain('waiting up to 5s for you to open the RDP session');
    expect(output).toContain('shell:startup');
    expect(output).toContain('\\\\tsclient\\Q\\agent\\remote-agent.ps1');
    expect(output).toContain('agent is up');
    await host.close();
    await agent.stop();
  });

  test('close() in manual mode leaves the agent running (the user owns it); with REMOTE_LOGOFF it shuts it down and asks for a logoff', async () => {
    await withRig(async ({ host, agent }) => {
      await host.close();
      expect(agent.isRunning).toBe(true);
      expect(agent.processed).not.toContain('shutdown');
    });
    await withRig({ config: { logoff: true } }, async ({ host, agent }) => {
      await host.close();
      expect(agent.processed).toContain('shutdown');
      expect(agent.shutdownLogoff).toBe(true);
      expect(agent.isRunning).toBe(false);
      expect(fs.existsSync(agent.paths.heartbeat)).toBe(false);
    });
  });

  test('the shutdown request stops the agent and removes its heartbeat', async () => {
    await withRig(async ({ host, agent }) => {
      await host.request('shutdown', {});
      await expect.poll(() => agent.isRunning).toBe(false);
      await expect.poll(() => fs.existsSync(agent.paths.heartbeat)).toBe(false);
      expect(agent.shutdownLogoff).toBe(false);
    });
  });

  test('the last client out closes the session; earlier ones leave it for the others', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    const config = testConfig(share, { logoff: true });
    const a = new RemoteHost(config);
    const b = new RemoteHost(config);
    await Promise.all([a.connect(), b.connect()]);
    expect(files(path.join(share, 'agent', 'clients'))).toHaveLength(2);
    await a.close();
    expect(agent.processed).not.toContain('shutdown');
    expect(files(path.join(share, 'agent', 'clients'))).toHaveLength(1);
    expect((await b.ping()).host).toBe('STAND-IN-HOST');
    await b.close();
    expect(agent.processed).toContain('shutdown');
    expect(files(path.join(share, 'agent', 'clients'))).toEqual([]);
    await agent.stop();
  });

  test('keepOpen leaves the agent running even for the last client with logoff set', async () => {
    await withRig({ config: { logoff: true, keepOpen: true } }, async ({ host, agent }) => {
      await host.close();
      expect(agent.isRunning).toBe(true);
    });
  });

  test('alternate-shell end to end (fake mstsc): subst, login handed over, session opened, credential deleted once the agent is up, closed again', async () => {
    const share = tmpDir();
    const runner = new FakeRunner();
    const agent = new StandInAgent({ shareDir: share });
    runner.onLaunch = () => void agent.start(); // "mstsc" brings the agent up
    const config = testConfig(share, { agentStart: 'alternate-shell', user: 'svc', password: 'Sup3rSecret!', domain: 'CORP' });
    const host = new RemoteHost(config, { runner });
    const { error, output } = await captureStdout(async () => {
      await host.connect();
      runner.launched[0]!.hasExited = () => !agent.isRunning; // the session ends when the agent does
      expect((await host.ping()).host).toBe('STAND-IN-HOST');
      await host.close();
    });
    expect(error).toBeUndefined();
    expect(runner.commands.filter((c) => !c.startsWith('launch'))).toEqual([
      'subst',
      `subst R: ${share}`,
      'cmdkey /generic:TERMSRV/rdp-host.test /user:CORP\\svc /pass:Sup3rSecret!',
      'cmdkey /delete:TERMSRV/rdp-host.test',
      'subst R: /D',
    ]);
    expect(runner.commands[3]).toMatch(/^launch mstsc .*\.rdp$/);
    expect(agent.processed).toEqual(['ping', 'shutdown']); // we started the session, so closing ends it
    expect(runner.launched[0]?.killed).toBe(false);
    expect(output).not.toContain('Sup3rSecret!');
    expect(files(path.join(share, 'agent', 'clients'))).toEqual([]);
    await agent.stop();
  });

  test('alternate-shell on a machine that is not Windows fails with UNSUPPORTED_PLATFORM, never by running a command', async () => {
    const share = tmpDir();
    const runner = new FakeRunner('darwin');
    const host = new RemoteHost(testConfig(share, { agentStart: 'alternate-shell', user: 'u', password: 'p' }), { runner });
    const error = (await host.connect().catch((e: unknown) => e)) as RemoteError;
    expect(error.code).toBe('UNSUPPORTED_PLATFORM');
    expect(runner.calls).toEqual([]);
    expect(files(path.join(share, 'agent', 'clients'))).toEqual([]); // the failed connect unregistered itself
  });

  test('a failed RDP start explains itself with the checklist, mentions an mstsc that ended, and still deletes the credential', async () => {
    const share = tmpDir();
    const runner = new FakeRunner();
    runner.onLaunch = () => setTimeout(() => runner.launched[0]?.end(5), 50);
    const host = new RemoteHost(testConfig(share, { agentStart: 'alternate-shell', user: 'u', password: 'pw-secret', connectTimeoutMs: 400 }), { runner });
    const error = (await host.connect().catch((e: unknown) => e)) as RemoteError;
    expect(error.code).toBe('AGENT_NOT_STARTED');
    expect(error.message).toContain('our mstsc window ended (exit code 5)');
    expect(error.message).not.toContain('pw-secret');
    expect(runner.commands.filter((c) => c.startsWith('cmdkey /delete'))).toHaveLength(1);
    expect(runner.commands).toContain('subst R: /D');
    expect(fs.existsSync(path.join(share, 'agent', 'starting.lock'))).toBe(false);
  });

  test('two processes connecting at once open ONE RDP session (the other waits for its agent)', async () => {
    const share = tmpDir();
    const runner = new FakeRunner();
    const agent = new StandInAgent({ shareDir: share });
    runner.onLaunch = () => setTimeout(() => void agent.start(), 150);
    const config = testConfig(share, { agentStart: 'alternate-shell', user: 'u', password: 'p' });
    const a = new RemoteHost(config, { runner });
    const b = new RemoteHost(config, { runner });
    await Promise.all([a.connect(), b.connect()]);
    expect(runner.calls.filter((c) => c.kind === 'launch')).toHaveLength(1);
    expect((await a.ping()).host).toBe('STAND-IN-HOST');
    expect((await b.ping()).host).toBe('STAND-IN-HOST');
    runner.launched[0]!.hasExited = () => !agent.isRunning;
    await a.close();
    expect(agent.processed).not.toContain('shutdown'); // b is still using it
    await b.close();
    expect(agent.processed).toContain('shutdown');
    await agent.stop();
  });
});

test.describe('diagnose', () => {
  test('every stage passes against a healthy agent, including the optional http, db and exec probes', async () => {
    const server = await startHttpServer();
    try {
      await withRig({ config: { allow: ['http', 'db', 'sap', 'exec'], dbProvider: DB.provider, dbConnectionString: DB.connectionString }, connect: false }, async ({ host }) => {
        const stages = await host.diagnose({ url: `${server.url}/echo`, db: true, exec: true });
        expect(stages.map((s) => s.name)).toEqual(['configuration', 'mailbox folder', 'agent connection', 'ping', 'interactive session', `http GET ${server.url}/echo`, 'db SELECT 1', 'exec hostname']);
        expect(stages.filter((s) => !s.ok)).toEqual([]);
        expect(stages.every((s) => s.hint === '')).toBe(true);
        expect(stages[3]?.detail).toContain('STAND-IN-HOST');
      });
    } finally {
      await server.close();
    }
  });

  test('a stage that fails says what to do, and an agent on a non-interactive desktop is flagged', async () => {
    await withRig({ agent: { interactive: false }, connect: false }, async ({ host }) => {
      const stages = await host.diagnose({ url: 'http://127.0.0.1:1/', db: true, exec: true });
      const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
      expect(byName['interactive session']).toMatchObject({ ok: false });
      expect(byName['interactive session']?.hint).toContain('SAP GUI scripting only sees an interactive desktop');
      expect(byName['http GET http://127.0.0.1:1/']).toMatchObject({ ok: false });
      expect(byName['http GET http://127.0.0.1:1/']?.hint).toContain('from the host itself');
      expect(byName['db SELECT 1']?.hint).toContain('REMOTE_DB_PROVIDER');
      expect(byName['exec hostname']).toMatchObject({ ok: false });
      expect(byName['exec hostname']?.hint).toContain('REMOTE_ALLOW');
    });
  });

  test('it stops at the first broken link: no agent -> configuration, mailbox, agent connection (failed)', async () => {
    const share = tmpDir();
    const host = new RemoteHost(testConfig(share, { connectTimeoutMs: 200 }));
    const stages = await host.diagnose({ db: true });
    expect(stages.map((s) => [s.name, s.ok])).toEqual([['configuration', true], ['mailbox folder', true], ['agent connection', false]]);
    expect(stages[2]?.detail).toContain('Likely causes');
    expect(stages[2]?.hint).toContain('Troubleshooting');
  });

  test('alternate-shell on a machine that is not Windows fails at "RDP prerequisites" and goes no further', async () => {
    const host = new RemoteHost(testConfig(tmpDir(), { agentStart: 'alternate-shell', user: 'u', password: 'pw-secret-diag' }), { runner: new FakeRunner('linux') });
    const stages = await host.diagnose();
    expect(JSON.stringify(stages)).not.toContain('pw-secret-diag');
    expect(stages.map((s) => s.name)).toEqual(['configuration', 'mailbox folder', 'RDP prerequisites']);
    expect(stages[2]).toMatchObject({ ok: false });
    expect(stages[2]?.detail).toContain('not Windows');
    expect(stages[0]?.detail).not.toMatch(/\bp\b.*pass/);
  });
});

test.describe('one remote host per worker process', () => {
  test('getRemoteHost: undefined when disabled; otherwise connects once and returns the same host until closeRemoteHost()', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    const env = reader({ REMOTE_ENABLED: 'true', REMOTE_RDP_HOST: 'h', REMOTE_AGENT_START: 'manual', REMOTE_SHARE_DIR: share, REMOTE_POLL_MS: '20', REMOTE_HEARTBEAT_MS: '100', REMOTE_HEARTBEAT_STALE_MS: '1000' });
    try {
      expect(await getRemoteHost(reader({ REMOTE_ENABLED: 'false' }))).toBeUndefined();
      await closeRemoteHost(); // the undefined answer was cached too
      const [first, second] = await Promise.all([getRemoteHost(env), getRemoteHost(env)]);
      expect(first).toBeInstanceOf(RemoteHost);
      expect(second).toBe(first);
      expect(await getRemoteHost(reader({ REMOTE_ENABLED: 'false' }))).toBe(first); // one per process: the first one wins
      expect(files(path.join(share, 'agent', 'clients'))).toHaveLength(1);
      expect((await first!.ping()).host).toBe('STAND-IN-HOST');
      await closeRemoteHost();
      expect(files(path.join(share, 'agent', 'clients'))).toEqual([]);
      const again = await getRemoteHost(env);
      expect(again).not.toBe(first);
      expect(await RemoteDbClient.fromEnv(env)).toBeInstanceOf(RemoteDbClient);
    } finally {
      await closeRemoteHost();
      await agent.stop();
    }
  });

  test('a failed connect is remembered: later calls fail at once instead of waiting out the timeout again', async () => {
    const env = reader({ REMOTE_ENABLED: 'true', REMOTE_RDP_HOST: 'h', REMOTE_AGENT_START: 'manual', REMOTE_SHARE_DIR: tmpDir(), REMOTE_CONNECT_TIMEOUT_MS: '300', REMOTE_POLL_MS: '20' });
    try {
      await expect(getRemoteHost(env)).rejects.toMatchObject({ code: 'AGENT_NOT_STARTED' });
      const started = Date.now();
      await expect(getRemoteHost(env)).rejects.toMatchObject({ code: 'AGENT_NOT_STARTED' });
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      await closeRemoteHost();
    }
  });

  test('RemoteHost.fromEnv is undefined when disabled', () => {
    expect(RemoteHost.fromEnv(reader({}))).toBeUndefined();
  });
});

test.describe('secrets', () => {
  const RDP_PASSWORD = 'Rdp-Pa55-never-print';
  const DB_SECRET = 'Db-Pwd-never-print';

  test('neither the RDP password nor the DB connection string appears in a log line, an error message or a result', async () => {
    const share = tmpDir();
    const agent = new StandInAgent({ shareDir: share });
    await agent.start();
    const config = testConfig(share, { password: RDP_PASSWORD, user: 'svc', dbProvider: 'p', dbConnectionString: `Data Source=:memory:;Password=${DB_SECRET}` });
    const host = new RemoteHost(config);
    const seen: string[] = [];
    const { output } = await captureStdout(async () => {
      await host.connect();
      seen.push(JSON.stringify(await host.ping()));
      seen.push(JSON.stringify(await host.dbQuery('SELECT 1 AS one')));
      for (const failing of [() => host.dbQuery('SELEC nonsense'), () => host.exec({ command: 'x' }), () => host.request('nope' as never, {})]) {
        const error = (await failing().catch((e: unknown) => e)) as Error;
        seen.push(error.message, String((error as { detail?: string }).detail), JSON.stringify(error));
      }
      seen.push(JSON.stringify(config), String(config.toJSON().password));
      await host.close();
    });
    await agent.stop();
    for (const text of [output, ...seen]) {
      expect(text).not.toContain(RDP_PASSWORD);
      expect(text).not.toContain(DB_SECRET);
    }
    expect(output).toContain('connect'); // there was something to scan
  });
});
