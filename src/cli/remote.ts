#!/usr/bin/env node
import * as fs from 'node:fs';
import { loadEnv } from '../config/env';
import { remoteConfigFromEnv, type RemoteConfig } from '../remote/config';
import { bundledAgentDir, ensureMailbox, installAgentFiles } from '../remote/mailbox';
import { LAYOUT, remotePaths } from '../remote/protocol';
import { checkRdpPrerequisites } from '../remote/rdp';
import { RemoteHost } from '../remote/remoteHost';
import { setupHelp } from '../remote/setupHelp';
import { parseFlags, UsageError } from './args';
import * as path from 'node:path';

const USAGE = `automation-remote - run DB / API / SAP steps on a remote desktop host over Remote Desktop (RDP drive mailbox)

  automation-remote doctor                       local prerequisites (Windows? interactive session? mstsc/cmdkey/subst? config valid?)
  automation-remote check [--url <http url>] [--db] [--exec]
                                                 connect, then test the chain stage by stage: agent, ping, optional HTTP GET from
                                                 the host, optional SELECT 1, optional "hostname" (needs exec in REMOTE_ALLOW)
  automation-remote open                         connect and leave the session open (REMOTE_AGENT_START=alternate-shell opens RDP)
  automation-remote close                        ask a running agent to shut down and release the subst drive
  automation-remote agent-dir                    print <REMOTE_SHARE_DIR>/agent (the folder is created with the agent files in it)
  automation-remote setup-help                   the one-time setup steps for REMOTE_AGENT_START=startup / manual

Settings come from .env.<ENV> (ENV=qa by default) and the environment; keep REMOTE_RDP_PASSWORD and
REMOTE_DB_CONNECTION_STRING in .env.<env>.local. See docs/REMOTE_DESKTOP.md.
NOT VERIFIED on a real Windows host: the RDP launcher and the PowerShell agent have never run on Windows.

Exit codes: 0 ok, 1 a check failed (doctor: including an invalid configuration), 2 bad command line, or a bad
configuration in any other command.
`;

type Level = 'PASS' | 'FAIL' | 'WARN';
const out = (text: string) => process.stdout.write(`${text}\n`);
const line = (level: Level, name: string, detail: string, hint = '') => {
  out(`${level}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (hint) out(`      hint: ${hint}`);
};

/**
 * Does this process look like it runs on an interactive Windows desktop? `mstsc` needs a desktop: a Windows service or
 * a scheduled task without one cannot open the RDP session. SESSIONNAME is `Console`, `RDP-Tcp#3` (and similar for
 * WorkSpaces protocols) in a desktop session and `Services` (or absent) otherwise. Only a hint - hence a warning.
 */
export function describeSession(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { interactive: boolean; detail: string } {
  if (platform !== 'win32') return { interactive: false, detail: `this machine is ${platform}, not Windows` };
  const name = env.SESSIONNAME;
  if (!name) return { interactive: false, detail: 'SESSIONNAME is not set' };
  if (name.toLowerCase() === 'services') return { interactive: false, detail: 'SESSIONNAME is "Services"' };
  return { interactive: true, detail: `SESSIONNAME=${name}` };
}

function loadConfig(): RemoteConfig {
  let config: RemoteConfig | undefined;
  try {
    config = remoteConfigFromEnv(loadEnv());
  } catch (error) {
    throw new UsageError((error as Error).message); // a bad setting is a usage problem (exit 2), not a failed check
  }
  if (!config) throw new UsageError('REMOTE_ENABLED is not true - set REMOTE_ENABLED=true and REMOTE_RDP_HOST in .env.<env> (see .env.example)');
  return config;
}

function doctor(): number {
  let failed = false;
  let config: RemoteConfig | undefined;
  try {
    config = loadConfig();
    line('PASS', 'configuration', JSON.stringify(config)); // secrets are masked by RemoteConfig.toJSON
  } catch (error) {
    failed = true;
    line('FAIL', 'configuration', (error as Error).message, 'see .env.example for every REMOTE_* key');
  }
  const session = describeSession(process.env, process.platform);
  if (session.interactive) line('PASS', 'interactive Windows session', session.detail);
  else
    line(
      'WARN',
      'interactive Windows session',
      session.detail,
      'start the tests from a logged-in desktop session (and keep it connected): mstsc needs a desktop, a service, a scheduled task without one or a Linux machine cannot open the RDP session',
    );
  const prerequisites = checkRdpPrerequisites();
  const needsRdp = config?.agentStart === 'alternate-shell';
  const missing = prerequisites.tools.filter((t) => !t.found).map((t) => t.name);
  if (prerequisites.windows && missing.length === 0) line('PASS', 'RDP tools', 'mstsc, cmdkey and subst found');
  else if (needsRdp) {
    failed = true;
    line('FAIL', 'RDP tools', prerequisites.windows ? `not on the PATH: ${missing.join(', ')}` : `this machine is ${prerequisites.platform}, not Windows`, 'run on the Windows test machine, or use REMOTE_AGENT_START=startup|manual');
  } else line('PASS', 'RDP tools', `not needed with REMOTE_AGENT_START=${config?.agentStart ?? '?'} (you open the RDP session yourself)`);
  const bundled = bundledAgentDir();
  const absent = [LAYOUT.agentScript, LAYOUT.startCmd].filter((f) => !fs.existsSync(path.join(bundled, f)));
  if (absent.length === 0) line('PASS', 'agent files', bundled);
  else {
    failed = true;
    line('FAIL', 'agent files', `missing from the package: ${absent.join(', ')}`, `reinstall the package ("agent" must be in package.json "files")`);
  }
  if (config) {
    try {
      ensureMailbox(remotePaths(config.shareDir));
      line('PASS', 'mailbox folder', config.shareDir);
    } catch (error) {
      failed = true;
      line('FAIL', 'mailbox folder', (error as Error).message, 'REMOTE_SHARE_DIR must be a writable folder on this machine');
    }
    if (config.allow.includes('exec')) line('WARN', 'exec allowed', 'REMOTE_ALLOW includes exec: steps can run arbitrary commands on the host', 'remove exec unless a suite needs it');
  }
  return failed ? 1 : 0;
}

async function check(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, { '--url': 'string', '--db': 'boolean', '--exec': 'boolean' });
  const host = new RemoteHost(loadConfig());
  try {
    const stages = await host.diagnose({ url: flags['--url'] as string | undefined, db: flags['--db'] === true, exec: flags['--exec'] === true });
    for (const stage of stages) line(stage.ok ? 'PASS' : 'FAIL', stage.name, stage.detail, stage.hint);
    return stages.every((s) => s.ok) ? 0 : 1;
  } finally {
    await host.close();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out(USAGE.trimEnd());
    return command ? 0 : 2;
  }
  const rest = argv.slice(1);
  switch (command) {
    case 'doctor':
      parseFlags(rest, {});
      return doctor();
    case 'check':
      return check(rest);
    case 'open': {
      parseFlags(rest, {});
      const host = new RemoteHost(loadConfig());
      await host.connect();
      out(`agent is up; the remote session stays open (agent folder ${host.paths.agent})`);
      await host.close({ keepOpen: true });
      return 0;
    }
    case 'close': {
      parseFlags(rest, {});
      const result = await new RemoteHost(loadConfig()).closeSession();
      out(result.agentWasRunning ? 'shutdown requested; the agent is stopping' : 'no agent was running');
      if (result.driveReleased) out('the subst drive was removed');
      return 0;
    }
    case 'agent-dir': {
      parseFlags(rest, {});
      const config = loadConfig();
      const paths = remotePaths(config.shareDir);
      installAgentFiles(paths);
      out(paths.agent);
      return 0;
    }
    case 'setup-help': {
      parseFlags(rest, {});
      const config = loadConfig();
      if (config.agentStart === 'alternate-shell')
        out('REMOTE_AGENT_START=alternate-shell needs no setup: this machine opens the RDP session and mstsc starts the agent.\nFor the other two modes:\n');
      out(config.agentStart === 'alternate-shell' ? `${setupHelp(config, 'startup')}\n${setupHelp(config, 'manual')}` : setupHelp(config));
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${error.message}\n\n${USAGE}`);
        process.exit(2);
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
