@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

echo ============================================
echo  PocketBrain  -  self-contained local LLM on a USB
echo ============================================
echo.

rem --- Portable Node detection/vendoring --------------------------------------
set "NODE_EXE=node.exe"
where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_CMD=node"
  goto :node_ok
)
set "NODE_DIR=%ROOT%\runtime\node-win-x64"
set "NODE_CMD=%NODE_DIR%\node.exe"
if exist "%NODE_CMD%" goto :node_ok

echo [runtime] Node.js not found. Vendoring portable Node ^(first-run only^)...
set "NODE_VER=v24.19.0"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
set "NODE_ZIP=%ROOT%\runtime\node.zip"
if not exist "%ROOT%\runtime" mkdir "%ROOT%\runtime"

echo [runtime] downloading %NODE_URL%
curl -L --fail -o "%NODE_ZIP%" "%NODE_URL%" 2>nul
if %errorlevel%==0 (
  powershell -NoProfile -Command "Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%ROOT%\runtime\' -Force" 2>nul
  rem node extracts to runtime\node-<ver>-win-x64\ ; normalize
  for /d %%D in ("%ROOT%\runtime\node-*-win-x64") do (
    if exist "%%D\node.exe" ren "%%D" "node-win-x64" 2>nul
    if exist "%ROOT%\runtime\node-v24.19.0-win-x64" if not exist "%NODE_DIR%" ren "%ROOT%\runtime\node-v24.19.0-win-x64" "node-win-x64" 2>nul
  )
  del "%NODE_ZIP%" 2>nul
)
if not exist "%NODE_CMD%" (
  echo [runtime] ERROR: could not vendor Node. Install Node.js or place it at %NODE_CMD%
  pause & exit /b 1
)
echo [runtime] Node ready: %NODE_CMD%

:node_ok

rem --- Provision llama.cpp + whisper.cpp + models for THIS machine ------------
rem Launcher detects OS/GPU/CPU, downloads the right build, keeps the CPU
rem build as fallback, prunes builds from other machines, fetches models.
rem POCKETBRAIN_VARIANT=win-cpu-x64 overrides detection if you ever need it.
echo.
echo [setup] detecting hardware^...
"%NODE_CMD%" "%ROOT%\backend\launcher.js"
if errorlevel 1 (
  echo.
  echo [setup] ERROR: provisioning failed. Check the network and try again.
  pause & exit /b 1
)

rem --- Start backend ----------------------------------------------------------
echo.
echo [pocketbrain] starting backend...
echo [pocketbrain] browser will open at http://127.0.0.1:3000
"%NODE_CMD%" "%ROOT%\backend\server.js"
rem server.js blocks until Ctrl+C; on exit we come back here.
goto :eof