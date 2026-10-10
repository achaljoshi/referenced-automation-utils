#!/usr/bin/env node
/**
 * A stand-in for `s3270`: the same line protocol (a command per line in; `data: ...` lines, a status line and
 * `ok`/`error` out), backed by the in-memory 3270 simulator, so the transport can be tested for real on any machine.
 * Fault injection: S3270_HANG=Enter (never answer it), S3270_CRASH=Ascii (write to stderr and exit 3 when it arrives),
 * S3270_DELAY_MS=150 (host unlock delay), S3270_SLOW=Home:500 (answer that command only after 500 ms - a late reply).
 */
const readline = require('node:readline');
const path = require('node:path');
const { createSampleMainframe } = require(path.resolve(__dirname, '../../dist/mainframe/fakeMainframe'));

const host = createSampleMainframe({ unlockDelayMs: Number(process.env.S3270_DELAY_MS || 0) });
const out = (line) => process.stdout.write(`${line}\n`);
const idle = 'U F U N I 4 24 80 0 0 0x0 -';

// Commands arrive one at a time, each answered before the next is read (as the real program does).
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
let busy = false;
rl.on('line', (line) => {
  lines.push(line);
  pump();
});

async function pump() {
  if (busy) return;
  busy = true;
  while (lines.length) {
    const command = lines.shift();
    const name = command.replace(/\(.*$/s, '');
    if (process.env.S3270_CRASH === name) {
      process.stderr.write(`fake s3270 crashed on ${name}\n`);
      process.exit(3);
    }
    if (process.env.S3270_HANG === name) continue;
    const [slowName, slowMs] = (process.env.S3270_SLOW || ':').split(':');
    if (slowName === name) await new Promise((resolve) => setTimeout(resolve, Number(slowMs)));
    try {
      const reply = await host.request(command);
      for (const d of reply.data) out(`data: ${d}`);
      out(reply.status.raw);
      out('ok');
    } catch (error) {
      out(`data: ${error.message}`);
      out(idle);
      out('error');
    }
    if (name === 'Quit') process.exit(0);
  }
  busy = false;
}
