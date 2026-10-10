@echo off
rem ============================================================================
rem The fortnightly framework audit over all five repos (they must be checked out next to each other).
rem
rem   scripts\audit-family.bat            automated checks only, a few seconds
rem   scripts\audit-family.bat --run      also runs lint, typecheck, test and security in every repo (slow)
rem
rem The report is written to ..\audit-reports\<date>\AUDIT_REPORT.md. Keep that folder between audits: the next run
rem compares with the newest earlier report. See docs\governance\AUDIT.md.
rem ============================================================================
setlocal
cd /d "%~dp0\.."
if not exist dist\cli\frameworkAudit.js call npm run build || exit /b 1
node dist\cli\frameworkAudit.js --family .. --out ..\audit-reports %*
exit /b %errorlevel%
