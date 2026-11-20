@echo off
setlocal
title NeonAmp
cd /d "%~dp0"

echo.
echo   NEONAMP - local music player + OBS overlay
echo   ------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js was not found on PATH.
  echo       Install Node.js 20 or newer from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo   [!] Electron is missing - installing dependencies. This runs once.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [X] npm install failed. See the messages above.
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo   [!] Downloading the Electron binary...
    call node node_modules\electron\install.js
  )
)

echo   Starting NeonAmp...
echo   The overlay URL is shown in the title bar once the window opens.
echo.
call npm start

if errorlevel 1 (
  echo.
  echo   [X] NeonAmp exited with an error. See the messages above.
  pause
)
endlocal
