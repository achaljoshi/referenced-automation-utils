@echo off
REM ============================================================================
REM One-shot local setup: installs dependencies. This package never drives a
REM real browser (no `page`/`browser` fixtures are used), so unlike the ui/api
REM repos there is no `playwright install` step here.
REM
REM Usage: scripts\setup.bat
REM ============================================================================
setlocal
cd /d "%~dp0\.."

echo == Installing dependencies ==========================================
call npm ci
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Try: npm test
endlocal
