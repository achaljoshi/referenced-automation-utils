# 0008. SAP GUI: a transport seam, PowerShell by default, a Java/JACOB fallback

- **Status:** Accepted pending verification on a real SAP GUI (documented retrospectively)
- **Date:** 2026-10-10
- **Approved by:** _not yet recorded_

## Context
SAP GUI Scripting is a Windows COM API. The existing framework reaches it with JACOB (Java plus a native DLL matching the JVM's bitness). We need it from TypeScript, and the machines that run it may restrict PowerShell or COM.

## Decision
Everything above the transport talks to one small interface (`SapGuiTransport`: `request(command)`, `close()`), and commands are plain data. The default transport is a PowerShell bridge (no native module, one reviewable script); a Java helper behind the same line protocol reuses the existing JACOB setup where PowerShell is restricted (`SAP_GUI_TRANSPORT=java`). Every transport must pass one conformance suite (`sap-gui-doctor --conformance`). The full reasoning, the comparison with the Java framework and the verification status are in the SAP package's `docs/ARCHITECTURE.md`.

## Consequences
The riskiest part (the COM bridge) is isolated, swappable and testable against a simulator and stand-in bridges. **Cost and open risk:** the bridges themselves have not run against a real SAP GUI; that is the first thing to prove on a target machine.

## Alternatives considered
Calling COM from Node directly (native build toolchain); Appium/WinAppDriver (generic UI Automation, less reliable for SAP); keeping Java/JACOB as the only route (a second stack).
