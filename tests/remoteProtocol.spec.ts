import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { atomicWriteFile, heartbeatIsFresh, installAgentFiles, parseJsonText, readHeartbeat, toCrlf } from '../src/remote/mailbox';
import {
  AGENT_VERSION,
  CAPABILITY_FOR_TYPE,
  ERROR_CODES,
  HEARTBEAT_FIELDS,
  LAYOUT,
  PROTOCOL_VERSION,
  REQUEST_TYPES,
  remotePaths,
  MAX_EXEC_OUTPUT,
  MAX_REQUEST_AGE_MS,
  DEFAULT_MAX_ROWS,
} from '../src/remote/protocol';
import { cleanTmpDirs, tmpDir } from './support/remoteFixtures';

test.afterAll(cleanTmpDirs);

const agentDir = path.resolve(__dirname, '..', 'agent');
const ps1 = fs.readFileSync(path.join(agentDir, 'remote-agent.ps1'), 'utf8');
const cmd = fs.readFileSync(path.join(agentDir, 'start.cmd'), 'utf8');

test.describe('mailbox files', () => {
  test('the layout is the documented one', () => {
    const p = remotePaths('/box');
    expect([p.requests, p.responses, p.script, p.startCmd, p.config, p.heartbeat, p.log].map((f) => path.relative('/box', f).split(path.sep).join('/'))).toEqual([
      'requests',
      'responses',
      'agent/remote-agent.ps1',
      'agent/start.cmd',
      'agent/config.json',
      'agent/heartbeat.json',
      'agent/agent.log',
    ]);
  });

  test('atomic write: the target does not exist until the content is complete; no .tmp is left', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'r.json');
    const big = JSON.stringify({ data: 'x'.repeat(100_000) });
    let seen: { tmpExists: boolean; tmpComplete: boolean; targetExists: boolean } | undefined;
    atomicWriteFile(file, big, {
      beforeRename: (tmp) => {
        seen = { tmpExists: fs.existsSync(tmp), tmpComplete: fs.readFileSync(tmp, 'utf8') === big, targetExists: fs.existsSync(file) };
      },
    });
    expect(seen).toEqual({ tmpExists: true, tmpComplete: true, targetExists: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(big);
    expect(fs.readdirSync(dir)).toEqual(['r.json']);
    // replacing an existing file is atomic too: the old content stays until the rename
    atomicWriteFile(file, '{"v":2}', { beforeRename: () => expect(fs.readFileSync(file, 'utf8')).toBe(big) });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
  });

  test('a reader in another process that polls the folder never sees a partial file while large files are written', async () => {
    const dir = tmpDir();
    // The reader is a separate process (like the agent on the other side of the RDP drive), polling flat out.
    const readerScript = `
      const fs = require('node:fs'); const path = require('node:path');
      let torn = 0, reads = 0, stop = false;
      process.stdin.on('data', () => { stop = true; });
      (function poll() {
        for (const name of fs.readdirSync(${JSON.stringify(dir)})) {
          if (!name.endsWith('.json')) continue;
          try { JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, name), 'utf8')); reads++; }
          catch (e) { if (e.code !== 'ENOENT') torn++; }
        }
        if (stop) { console.log(JSON.stringify({ torn, reads })); process.exit(0); }
        setImmediate(poll);
      })();
      console.log('ready');
    `;
    const child = spawn(process.execPath, ['-e', readerScript], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    await expect.poll(() => output.includes('ready')).toBe(true);
    for (let i = 0; i < 60; i++) {
      const file = path.join(dir, `${i}.json`);
      atomicWriteFile(file, JSON.stringify({ i, pad: 'y'.repeat(3_000_000) }));
      await expect.poll(() => fs.existsSync(file)).toBe(true);
      fs.rmSync(file);
    }
    child.stdin.write('stop');
    await expect.poll(() => output.includes('"torn"'), { timeout: 10_000 }).toBe(true);
    const result = JSON.parse(output.split('\n').find((l) => l.startsWith('{')) as string) as { torn: number; reads: number };
    expect(result.torn).toBe(0);
    expect(result.reads).toBeGreaterThan(0);
  });

  test('parseJsonText accepts the byte-order mark Windows tools add', () => {
    expect(parseJsonText('﻿{"a":1}')).toEqual({ a: 1 });
  });

  test('agent files are installed with CRLF line endings, left alone when identical and replaced when they differ', () => {
    const share = tmpDir();
    const paths = remotePaths(share);
    const first = installAgentFiles(paths);
    expect(first.written.sort()).toEqual(['remote-agent.ps1', 'start.cmd']);
    for (const file of [paths.script, paths.startCmd]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('\r\n');
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // no lone LF or CR
    }
    expect(installAgentFiles(paths)).toEqual({ written: [], unchanged: ['remote-agent.ps1', 'start.cmd'] });
    fs.writeFileSync(paths.script, '# an older agent version\r\n');
    expect(installAgentFiles(paths).written).toEqual(['remote-agent.ps1']);
    expect(fs.readFileSync(paths.script, 'utf8')).toBe(toCrlf(ps1));
    expect(() => installAgentFiles(paths, tmpDir())).toThrow(/agent file .* is missing/);
  });

  test('heartbeat freshness is the file age on THIS machine, not the clock the host wrote into it', () => {
    const share = tmpDir();
    const paths = remotePaths(share);
    fs.mkdirSync(paths.agent, { recursive: true });
    expect(readHeartbeat(paths)).toBeUndefined();
    fs.writeFileSync(paths.heartbeat, JSON.stringify({ agentVersion: '1', updatedAt: '1999-01-01T00:00:00Z', allow: [] }));
    expect(heartbeatIsFresh(readHeartbeat(paths), 5000)).toBe(true); // host clock says 1999: irrelevant
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.heartbeat, old, old);
    expect(heartbeatIsFresh(readHeartbeat(paths), 5000)).toBe(false);
    fs.writeFileSync(paths.heartbeat, '{ half written');
    expect(readHeartbeat(paths)).toBeUndefined(); // a torn read is "not now", not a crash
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The PowerShell agent can not be run here. These tests keep its NAMES in step with protocol.ts, so the two files
// cannot drift unnoticed; they say nothing about whether the script behaves.

const between = (text: string, begin: string, end: string): string => {
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  expect(from, `${begin} marker`).toBeGreaterThanOrEqual(0);
  expect(to, `${end} marker`).toBeGreaterThan(from);
  return text.slice(from + begin.length, to);
};

test.describe('contract: protocol.ts <-> agent/remote-agent.ps1', () => {
  test('the handlers the agent dispatches are exactly the request types of the protocol (both directions)', () => {
    const dispatch = between(ps1, '# BEGIN-DISPATCH', '# END-DISPATCH');
    const handled = [...dispatch.matchAll(/^\s*'([a-z.]+)'\s*\{/gm)].map((m) => m[1]);
    expect(handled.sort()).toEqual([...REQUEST_TYPES].sort());
  });

  test('every request type appears in the capability table with the same REMOTE_ALLOW entry', () => {
    const table = between(ps1, '# BEGIN-CAPABILITIES', '# END-CAPABILITIES');
    const entries = Object.fromEntries([...table.matchAll(/^\s*'([a-z.]+)'\s*=\s*'([a-z]*)'/gm)].map((m) => [m[1], m[2]]));
    expect(Object.keys(entries).sort()).toEqual([...REQUEST_TYPES].sort());
    for (const type of REQUEST_TYPES) expect(entries[type], type).toBe(CAPABILITY_FOR_TYPE[type] ?? '');
  });

  test('every error code of the protocol is used by the agent, and the agent uses no other', () => {
    for (const code of ERROR_CODES) expect(ps1, code).toContain(`'${code}'`);
    const used = new Set([...ps1.matchAll(/Throw-Remote\s+'([A-Z_]+)'/g)].map((m) => m[1]));
    for (const code of used) expect(ERROR_CODES as readonly string[], `Throw-Remote '${code}'`).toContain(code);
    const codeLiterals = new Set([...ps1.matchAll(/code\s*=\s*'([A-Z_]+)'|\$code\s*=\s*'([A-Z_]+)'/g)].map((m) => m[1] ?? m[2]));
    for (const code of codeLiterals) expect(ERROR_CODES as readonly string[]).toContain(code);
  });

  test('versions, limits and file names match', () => {
    expect(ps1).toContain(`$AgentVersion = '${AGENT_VERSION}'`);
    expect(ps1).toContain(`$ProtocolVersion = ${PROTOCOL_VERSION}`);
    expect(ps1).toContain(`$MaxRequestAgeSeconds = ${MAX_REQUEST_AGE_MS / 1000}`);
    expect(ps1).toContain(`$MaxOutputChars = ${MAX_EXEC_OUTPUT}`);
    expect(ps1).toContain(`$DefaultMaxRows = ${DEFAULT_MAX_ROWS}`);
    for (const name of [LAYOUT.requestsDir, LAYOUT.responsesDir, LAYOUT.configFile, LAYOUT.heartbeatFile, LAYOUT.logFile]) expect(ps1, name).toContain(`'${name}'`);
    expect(cmd).toContain(LAYOUT.agentScript);
  });

  test('the agent writes every heartbeat field of the protocol', () => {
    const start = ps1.indexOf('$Info = @{');
    expect(start).toBeGreaterThan(0);
    const block = ps1.slice(start, ps1.indexOf('}', start));
    const fields = [...block.matchAll(/^\s*([A-Za-z]+)\s*=/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual([...HEARTBEAT_FIELDS].sort());
  });

  test('the response and request fields are the protocol ones', () => {
    for (const field of ['v ', 'id ', 'ok ', 'result ', 'error ', 'durationMs ']) expect(ps1).toMatch(new RegExp(`\\b${field}\\s*=`));
    for (const field of ['type', 'payload', 'correlationId']) expect(ps1).toContain(`'${field}'`);
  });

  test('the drift check can fail: a dispatch table that lacks a type is detected', () => {
    const broken = ps1.replace(/^\s*'proc\.stop'\s*\{.*$/m, '');
    const handled = [...between(broken, '# BEGIN-DISPATCH', '# END-DISPATCH').matchAll(/^\s*'([a-z.]+)'\s*\{/gm)].map((m) => m[1]);
    expect(handled.sort()).not.toEqual([...REQUEST_TYPES].sort());
  });
});

/** Strips PowerShell comments, strings and here-strings (not a parser: enough to count brackets). */
export function stripPowerShell(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const two = source.slice(i, i + 2);
    if (two === '<#') {
      const end = source.indexOf('#>', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (two === "@'" || two === '@"') {
      const close = `\n${two[1]}@`;
      const end = source.indexOf(close, i + 2);
      i = end === -1 ? source.length : end + close.length;
    } else if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === "'") {
      i++;
      while (i < source.length && !(source[i] === "'" && source[i + 1] !== "'")) i += source[i] === "'" ? 2 : 1;
      i++;
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '`' ? 2 : 1;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function unbalanced(code: string): string | undefined {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const ch of code) {
    if ('([{'.includes(ch)) stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return `unexpected ${ch}`;
  }
  return stack.length ? `unclosed ${stack.join('')}` : undefined;
}

test.describe('the agent files stay safe to ship', () => {
  for (const [name, text] of [['remote-agent.ps1', ps1], ['start.cmd', cmd]] as const) {
    test(`${name}: ASCII only, no tabs, one kind of line ending, carries the NOT VERIFIED banner`, () => {
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/[^\x00-\x7f]/); // PowerShell 5.1 reads a BOM-less file as ANSI: non-ASCII would corrupt
      expect(text).not.toContain('\t');
      const crlf = (text.match(/\r\n/g) ?? []).length;
      const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
      expect(crlf === 0 || lf === 0, 'mixed line endings').toBe(true);
      expect(text).toMatch(/NOT VERIFIED on a real Windows host/);
      expect(text.endsWith('\n')).toBe(true);
    });
  }

  test('after the CRLF conversion the client applies, every line of both files ends in CRLF', () => {
    for (const text of [ps1, cmd]) {
      const converted = toCrlf(text);
      expect(converted.split('\r\n').every((l) => !/[\r\n]/.test(l))).toBe(true);
    }
  });

  test('start.cmd runs the agent script with the same switches the .rdp alternate shell uses', () => {
    expect(cmd).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File');
    expect(cmd).toMatch(/^:run\r?$/m);
    expect(cmd).toMatch(/goto run/);
    expect(cmd).toContain('\\\\tsclient\\%~1\\agent\\');
  });

  test('remote-agent.ps1: brackets and braces balance once comments and strings are removed', () => {
    expect(unbalanced(stripPowerShell(ps1))).toBeUndefined();
    expect(unbalanced(stripPowerShell('function f { if ($x) { 1 }'))).toBe('unclosed {');
    expect(unbalanced(stripPowerShell("function f { '}' } # {"))).toBeUndefined(); // brackets inside strings / comments do not count
    expect(unbalanced(stripPowerShell('$a = (1, 2]'))).toBe('unexpected ]');
  });

  test('the agent never logs a request body: Write-AgentLog is never given payload, sql, headers or connection strings', () => {
    const calls = [...ps1.matchAll(/Write-AgentLog\s*\(?([^\n]*)/g)].map((m) => m[1] as string);
    for (const call of calls) expect(call, call).not.toMatch(/\$payload|\$sql|\$headers|\$connectionString|\$bodyBase64|\$scriptText|\$text\b/);
  });
});
