@echo off
rem Conquest of Europa server. Runs in this console window: close it (or press Ctrl+C)
rem to stop the server. The game opens in your web browser.
setlocal
title Conquest of Europa server
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3000
set URL=http://localhost:%PORT%/

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

rem All dependencies: ws for the server, and the map tools Edit map > Rebuild navigation runs.
set NEED_INSTALL=
if not exist "node_modules\ws" set NEED_INSTALL=1
if not exist "node_modules\topojson-client" set NEED_INSTALL=1
if not exist "node_modules\world-atlas" set NEED_INSTALL=1
if defined NEED_INSTALL (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

rem A game server left running from an earlier start (old window still open) is stopped,
rem so the latest code is always used. Any other program on the port is an error.
powershell -NoProfile -Command "foreach ($l in @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue)) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $l.OwningProcess); if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server.index\.js') { Write-Host ('Stopping the game server that was already running (PID ' + $p.ProcessId + ')...'); Stop-Process -Id $p.ProcessId -Force; Start-Sleep -Milliseconds 500 } else { Write-Host ('Port %PORT% is used by another program. Close it, or run:  set PORT=3001 and start this file again.'); exit 1 } }; exit 0"
if errorlevel 1 (
  pause
  exit /b 1
)

rem Open the browser as soon as the server answers. This runs inside this same console
rem (start /b), so it must NOT use -WindowStyle Hidden: that would hide this window too.
start "" /b powershell -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing '%URL%' -TimeoutSec 1 | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep -Milliseconds 250 } }"

echo Conquest of Europa server
echo   On this PC:  %URL%
echo   Other players on your network: the address printed below.
echo   Close this window or press Ctrl+C to stop the server.
echo.
node server\index.js

echo.
echo Server stopped.
pause
