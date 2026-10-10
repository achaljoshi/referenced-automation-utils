@echo off
REM ============================================================================
REM One-shot setup: installs this repo's dependencies. This package never drives a real browser, so there is no `playwright install` step here.
REM
REM Dependencies are installed from the npm registry in NPM_REGISTRY_URL (the lockfile pins the versions).
REM
REM Usage: scripts\setup.bat
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

REM Every npm command below fetches packages from this registry.
if defined NPM_REGISTRY_URL (
  call npm config set registry "%NPM_REGISTRY_URL%"
) else (
  echo NOTE: NPM_REGISTRY_URL is not set - npm keeps using the registry it is already configured with.
)

echo.
echo == Installing dependencies ============================================
call npm ci
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Try: npm test
endlocal
exit /b 0
