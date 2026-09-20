@echo off
setlocal
cd /d "%~dp0"

title Lodex Development Runner

if not exist "package.json" (
  echo [Lodex] package.json was not found.
  goto :failed
)

where node >nul 2>nul
if errorlevel 1 (
  echo [Lodex] Node.js 24 is required. Install it from https://nodejs.org
  goto :failed
)

node -e "process.exit(process.versions.node.startsWith('24.') ? 0 : 1)"
if errorlevel 1 (
  echo [Lodex] Node.js 24.11 or newer is required. Current version:
  node --version
  goto :failed
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [Lodex] npm was not found. Repair the Node.js installation.
  goto :failed
)

where cargo.exe >nul 2>nul
if errorlevel 1 (
  echo [Lodex] Rust and Cargo are required. Install them from https://rustup.rs
  goto :failed
)

if not exist "node_modules\.package-lock.json" (
  echo [Lodex] Installing npm packages for the first run...
  call npm ci
  if errorlevel 1 goto :failed
)

if /i "%~1"=="--check" (
  echo [Lodex] Checking and preparing the development runtime...
  call npm run prepare:runtime
  if errorlevel 1 goto :failed
  echo [Lodex] Ready to run.
  exit /b 0
)

echo [Lodex] Starting the desktop app in development mode.
echo Close this window or press Ctrl+C to stop Lodex.
call npm run dev
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo [Lodex] Startup failed. Review the error above.
pause
exit /b 1
