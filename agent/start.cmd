@echo off
rem start.cmd - starts the remote agent inside the logged-in RDP session of the remote host.
rem
rem NOT VERIFIED on a real Windows host: written and reviewed on macOS, never run on Windows.
rem
rem Usage:  start.cmd            runs remote-agent.ps1 from the folder this file is in
rem         start.cmd R          runs it from \\tsclient\R\agent (for a copy of this file kept elsewhere)
rem Needs Windows PowerShell 5.1. The agent runs in a minimised window; close that window to stop it.
if not "%~1"=="" goto byletter
set "AGENT_DIR=%~dp0"
goto run
:byletter
set "AGENT_DIR=\\tsclient\%~1\agent\"
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%AGENT_DIR%remote-agent.ps1"
