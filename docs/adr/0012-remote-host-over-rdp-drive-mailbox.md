# 0012. Steps on a remote desktop host go through an "RDP drive mailbox"

- **Status:** Proposed - NOT VERIFIED on a real Windows host (the TypeScript is tested against a stand-in agent; the RDP launcher and the PowerShell agent have never run on Windows)
- **Date:** 2026-10-11
- **Approved by:** _not yet recorded_

## Context
The tests run on a Windows **test machine** (for example an AWS WorkSpace), where the UI application is reachable. The database, the APIs and SAP GUI are reachable only from a **remote Windows desktop host** that has no internet access. The test machine reaches that host by Remote Desktop (RDP, port 3389) and **no other port is open** - no SSH, no WinRM, no SMB. SAP GUI runs in the interactive RDP session, and SAP GUI scripting only sees the interactive desktop, so the helper that drives it has to run **inside** the logged-in session. The user wants the RDP login in `.env` and one utility that logs in and performs DB / API / SAP / other steps on that host, while the UI steps of the same test stay local. The development machine is macOS: Windows-specific code can not be run while writing it.

## Decision
Requests travel as files through one redirected drive ("RDP drive mailbox").

- The test machine launches `mstsc` with **one** redirected drive: a `subst` drive letter mapped to a private mailbox folder (never a real drive such as `C:`), so the folder appears inside the session as `\\tsclient\<L>`. Clipboard, printers, COM ports, smart cards and audio are off.
- A **PowerShell agent**, running inside the session, polls `requests/`, executes each request on the host (`ping`, `http`, `db.query`, `db.update`, `exec`, `proc.start|send|stop`, `shutdown`) and writes `responses/<id>.json`. The agent script is delivered through the same folder; nothing is installed on the host. The agent starts through `mstsc`'s `alternate shell` (default), a Startup-folder entry, or by hand (`REMOTE_AGENT_START`).
- The client (`RemoteHost`, `src/remote`) writes requests and polls for responses. Every file is written atomically (`<name>.tmp`, then rename). The wire contract is `src/remote/protocol.ts`; the PowerShell file repeats its names as constants and a test keeps the two in step.
- The login is handed to `mstsc` through `cmdkey` (generic credential `TERMSRV/<host>`) and deleted as soon as the agent's heartbeat appears or the connect times out - in a `finally`. The password is never in the `.rdp` file, a log line, an error or a result.
- Capabilities are an allow list (`REMOTE_ALLOW`, default `http,db,sap`); `exec` must be listed explicitly. It is enforced by the client **and** by the agent.
- Everything Windows-specific is driven through an injectable `CommandRunner`, so tests assert the exact `subst` / `cmdkey` / `mstsc` invocations against a recording fake.

Design points that go beyond the brief, each chosen for a reason:
- **Heartbeat freshness is the file's age on the test machine** (its modification time), not the `updatedAt` the host wrote: the host has no internet and its clock may be wrong. The agent measures request age against the heartbeat file's own timestamp for the same reason.
- **The heartbeat is written from a second PowerShell runspace**, so a long request (a slow query, an `exec` with a long timeout) does not make a healthy agent look dead. The agent handles one request at a time.
- **The single-instance mutex is per session** (`Local\`), not global: a global one would stop the agent in a new session while an old, disconnected session still holds it (and its drive is dead).
- **Parallel Playwright workers share one session**: a lock file lets only one process open RDP, `agent/clients/` records who uses it, and the last client out closes it. A leftover mailbox from a crashed run is purged at connect when no agent is running, so a stale request is not executed by the next agent.
- **`close()`** sends `shutdown` (and `logoff` when `REMOTE_LOGOFF`) when this machine started the session (`alternate-shell`, where the agent *is* the shell, so ending it ends the session) or `REMOTE_LOGOFF` is set; in `startup` / `manual` mode the user owns the agent and it is left running. `REMOTE_RDP_KEEP_OPEN` leaves everything running.
- The agent uses `System.Web.Script.Serialization.JavaScriptSerializer` (not `ConvertFrom-Json`, which fails on payloads over 2 MB in PowerShell 5.1).
- `RemoteError` extends `AdapterError` (itself an `Error`) so that `adapterStep` passes it through unchanged and `instanceof RemoteError` keeps working; it carries `code` and, for answers from the agent, `remoteCode` (`BAD_REQUEST`, `NOT_FOUND`).
- Small additions to the contract, all optional on the wire: `correlationId` on a request (ADR 0004 across the hop), `truncated` on a DB result, `logoff` on `shutdown`.

## Consequences
- Tests can mix local UI steps and remote DB / API / SAP steps, with nothing but port 3389 open and nothing installed on the host.
- It fails fast and says why: `AGENT_NOT_STARTED` carries a numbered checklist (login, drive redirection policy, `alternate shell`, PowerShell blocked, crashed agent), `AGENT_STALE` replaces a hang when the session dies, `DENIED` / `TIMEOUT` name the operation.
- **Costs and limits.** Latency of about 0.2-0.5 s per request (polling a folder). The agent works through requests one at a time. Request bodies - SQL, headers with tokens, connection strings - cross the drive as files (deleted after each reply; the folder must be readable only by the test user). The session must stay connected and unlocked, the minimised RDP window must stay open, and the tests must be started from an interactive desktop session on the test machine (`mstsc` needs one). Group policy on the RDP host can disable drive redirection, which makes this transport impossible (there is deliberately no second channel). The RDP link is nested inside the WorkSpace's session, so the host's policies matter, and the mailbox lives on the WorkSpace's disk. `sap` (helper processes) can run arbitrary PowerShell and is therefore nearly as powerful as `exec`. `cmdkey` puts the password on its command line for a moment, and it replaces and deletes any credential already saved for that host.
- **Open risk (the first thing to prove on a real machine):** none of the Windows side has run. That `mstsc` redirects a `subst` drive and honours `alternate shell`, the output of `subst` and `cmdkey`, how the redirected share behaves for atomic renames and timestamps, PowerShell 5.1 specifics of the agent script, and SAP GUI scripting from the agent's session are all assumptions. They are listed in `docs/REMOTE_DESKTOP.md` (Verified / NOT verified). Until a real run, treat this ADR as a proposal.
- The `api` and `sap` packages will use `getRemoteHost()`, `RemoteDbClient` and `startProcess` in follow-up work in their own repos; this package only provides the remote host.

## Alternatives considered
- **SSH / WinRM / PsExec / SMB to the host** - the brief says no other port is open.
- **A Windows service or scheduled task on the host** - runs in session 0 or without the interactive desktop; SAP GUI scripting would not see the user's SAP GUI.
- **Driving the RDP window** (UI automation, clipboard paste, screen scraping) - fragile, slow, and needs the window focused; the drive redirection is a plain, observable file channel.
- **Redirecting the clipboard or a serial port as the channel** - small, awkward, shared with the user's own use, and often disabled together with drive redirection.
- **Redirecting a real drive or all drives** - exposes the test machine's disks to the host; a `subst` drive limits it to one private folder.
- **A tunnelled port (RDP port forwarding, reverse tunnel)** - needs listening ports or a tool on the host.
- **`ConvertFrom-Json` in the agent** - 2 MB limit in PowerShell 5.1; replaced by `JavaScriptSerializer`.
