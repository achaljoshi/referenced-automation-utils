import type { RemoteAgentStart, RemoteConfig } from './config';
import { agentCommandLine } from './rdp';
import { remotePaths } from './protocol';

/**
 * The one-time steps for the `startup` and `manual` start modes (the `alternate-shell` mode needs none: this machine
 * opens the session itself). Printed by `automation-remote setup-help` and, shortened, while waiting for an agent.
 */
export function setupHelp(config: RemoteConfig, mode: RemoteAgentStart = config.agentStart): string {
  const letter = config.driveLetter;
  const paths = remotePaths(config.shareDir);
  const mapDrive = [
    `  1. On the test machine, make the mailbox folder a drive of its own (never redirect a real drive such as C:):`,
    `       subst ${letter}: "${config.shareDir}"`,
    `     "automation-remote agent-dir" creates that folder with the agent files in it (${paths.agent}).`,
    `  2. Start Remote Desktop (mstsc) to ${config.host}:${config.port}. Under Show Options > Local Resources >`,
    `     Local devices and resources > More... > Drives, tick ONLY ${letter}: (leave the clipboard and printers off),`,
    `     then connect and log in. Inside the session the folder is \\\\tsclient\\${letter}.`,
  ];
  const keepOpen = [
    `  Keep that RDP window open (minimising it is fine) and the session unlocked and connected while the tests run:`,
    `  SAP GUI scripting only sees the interactive desktop of a session that is still there.`,
  ];
  const lines =
    mode === 'startup'
      ? [
          `REMOTE_AGENT_START=startup - install the agent once in the host's Startup folder, then it starts at every logon.`,
          '',
          ...mapDrive,
          `  3. In the session press Win+R, type  shell:startup  and press Enter. In the folder that opens create a file`,
          `     remote-agent.cmd containing this single line:`,
          `       ${agentCommandLine(letter)}`,
          `  4. Log off and connect again (steps 1-2 each time) or run that line once from Win+R. When the agent is up,`,
          `     "automation-remote check" prints PASS for every stage.`,
          '',
          ...keepOpen,
          `  Note: the line only works in a session opened with the ${letter}: drive redirected; elsewhere it fails harmlessly.`,
        ]
      : [
          `REMOTE_AGENT_START=manual - you open the session and start the agent by hand each time.`,
          '',
          ...mapDrive,
          `  3. In the session press Win+R and run:  \\\\tsclient\\${letter}\\agent\\start.cmd`,
          `     (or double-click start.cmd in \\\\tsclient\\${letter}\\agent). A minimised PowerShell window is the agent.`,
          `  4. When the agent is up, "automation-remote check" prints PASS for every stage.`,
          '',
          ...keepOpen,
        ];
  return `${lines.join('\n')}\n`;
}
