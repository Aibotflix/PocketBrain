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
    if exist "%ROOT%\runtime\node-v22.11.0-win-x64" if not exist "%NODE_DIR%" ren "%ROOT%\runtime\node-v22.11.0-win-x64" "node-win-x64" 2>nul
  )
  del "%NODE_ZIP%" 2>nul
)
if not exist "%NODE_CMD%" (
  echo [runtime] ERROR: could not vendor Node. Install Node.js or place it at %NODE_CMD%
  pause & exit /b 1
)
echo [runtime] Node ready: %NODE_CMD%

:node_ok

rem --- llama.cpp binary detection/vendoring ------------------------------------
set "LLAMA_RELEASE=b10284"
set "BIN_OUT=%ROOT%\bin"
if not exist "%BIN_OUT%" mkdir "%BIN_OUT%"

rem Allow override: set POCKETBRAIN_VARIANT=win-cpu-x64 to force CPU, etc.
set "VARIANT=%POCKETBRAIN_VARIANT%"

if "!VARIANT!"=="" (
  rem --- ARM64 CPU? (Snapdragon laptops) ---
  echo %PROCESSOR_ARCHITECTURE% | findstr /i "ARM64" >nul
  if !errorlevel!==0 (
    echo [bin] ARM64 CPU detected -^> ARM64 CPU build
    set "VARIANT=win-cpu-arm64"
  )
)
if "!VARIANT!"=="" (
  rem --- NVIDIA: pick CUDA by driver version. RTX 50-series (Blackwell)
  rem needs driver 570+ (CUDA 13.x); older GPUs are fine on CUDA 12.4.
  where nvidia-smi >nul 2>nul
  if %errorlevel%==0 (
    for /f "delims=" %%V in ('nvidia-smi --query-gpu=driver_version --format=csv,noheader 2^>nul') do set "DRV=%%V"
    for /f "tokens=1 delims=." %%M in ("!DRV!") do set "DRV_MAJOR=%%M"
    if "!DRV_MAJOR!" GEQ "570" (
      echo [bin] NVIDIA driver !DRV! -^> CUDA 13.3 build ^(RTX 50-series ready^)
      set "VARIANT=win-cuda-13.3-x64"
    ) else (
      echo [bin] NVIDIA driver !DRV! -^> CUDA 12.4 build
      set "VARIANT=win-cuda-12.4-x64"
    )
  )
)
if "!VARIANT!"=="" (
  rem --- AMD Radeon via adapter names ---
  powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name" 2>nul > "%TEMP%\pocketbrain_gpus.txt"
  findstr /i /c:"Radeon" "%TEMP%\pocketbrain_gpus.txt" >nul 2>nul
  if !errorlevel!==0 (
    echo [bin] AMD Radeon GPU detected -^> HIP Radeon build
    set "VARIANT=win-hip-radeon-x64"
  )
  del "%TEMP%\pocketbrain_gpus.txt" 2>nul
)
if "!VARIANT!"=="" (
  rem --- Intel Arc / Iris Xe via adapter names ---
  powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name" 2>nul > "%TEMP%\pocketbrain_gpus.txt"
  findstr /i /c:"Arc" /c:"Iris" "%TEMP%\pocketbrain_gpus.txt" >nul 2>nul
  if !errorlevel!==0 (
    echo [bin] Intel GPU detected -^> SYCL build
    set "VARIANT=win-sycl-x64"
  )
  del "%TEMP%\pocketbrain_gpus.txt" 2>nul
)
if "!VARIANT!"=="" (
  echo [bin] No GPU confirmed -^> CPU build
  set "VARIANT=win-cpu-x64"
)

set "ARCH_NAME=llama-b10284-bin-!VARIANT!.zip"
rem CUDA needs the cudart sidecar zip too.
set "NEED_CUDART=0"
echo !VARIANT! | findstr /i "cuda" >nul && set "NEED_CUDART=1"

set "ASSET_DIR=%BIN_OUT%\!VARIANT!"
set "LLAMA_BIN=%ASSET_DIR%\llama-server.exe"
if exist "%LLAMA_BIN%" (
  echo [bin] cached: !VARIANT!
  goto :bin_ok
)

rem Use tar (bundled since Win10 1803) for expansion - it is 10-30x faster
rem than PowerShell Expand-Archive on the ~300 MB GPU zips. Fall back if absent.
if not exist "%ASSET_DIR%" mkdir "%ASSET_DIR%"
set "DL_URL=https://github.com/ggml-org/llama.cpp/releases/download/%LLAMA_RELEASE%/%ARCH_NAME%"
set "DL_ZIP=%TEMP%\pocketbrain_%ARCH_NAME%"
echo [bin] downloading %ARCH_NAME%
curl -L --fail --retry 3 -o "%DL_ZIP%" "%DL_URL%"
if errorlevel 1 (
  echo [bin] ERROR: download failed for %ARCH_NAME%
  pause & exit /b 1
)
echo !VARIANT! | findstr /i "cuda hip sycl" >nul
if !errorlevel!==0 (
  echo [bin] extracting - GPU builds are large, this can take several minutes...
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\backend\extract.ps1" -Zip "%DL_ZIP%" -Dest "%ASSET_DIR%"
if errorlevel 1 (
  rem Fallback: tar (no progress bar) or Expand-Archive (slow) if the script fails.
  where tar >nul 2>nul
  if %errorlevel%==0 (
    rem -m = don't restore archive timestamps (FAT/exFAT USB can't store some
    rem ranges; otherwise tar spams "Can't restore time" per file).
    tar -mxf "%DL_ZIP%" -C "%ASSET_DIR%"
  ) else (
    powershell -NoProfile -Command "Expand-Archive -LiteralPath '%DL_ZIP%' -DestinationPath '%ASSET_DIR%' -Force"
  )
)
del "%DL_ZIP%" 2>nul

if %NEED_CUDART%==1 (
  set "CUDART_NAME=cudart-llama-bin-!VARIANT!.zip"
  set "CUDART_URL=https://github.com/ggml-org/llama.cpp/releases/download/b10284/cudart-llama-bin-!VARIANT!.zip"
  set "CUDART_ZIP=%TEMP%\pocketbrain_cudart.zip"
  echo [bin] downloading !CUDART_NAME! ^(CUDA runtime^) ...
  curl -L --fail -o "%CUDART_ZIP%" "!CUDART_URL!"
  if errorlevel 1 (
    echo [bin] WARN: cudart download failed; CUDA may not run. Try a CPU build instead.
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\backend\extract.ps1" -Zip "%CUDART_ZIP%" -Dest "%ASSET_DIR%"
    if errorlevel 1 (
      where tar >nul 2>nul
      if %errorlevel%==0 (
        tar -mxf "%CUDART_ZIP%" -C "%ASSET_DIR%"
      ) else (
        powershell -NoProfile -Command "Expand-Archive -LiteralPath '%CUDART_ZIP%' -DestinationPath '%ASSET_DIR%' -Force"
      )
    )
    del "%CUDART_ZIP%" 2>nul
  )
)

if not exist "%LLAMA_BIN%" (
  echo [bin] ERROR: llama-server.exe missing after extract ^(check %ASSET_DIR%^)
  pause & exit /b 1
)

:bin_ok

rem --- whisper.cpp (STT) binary ---------------------------------------------
set "WHISPER_ASSET=whisper-bin-x64.zip"
set "WHISPER_VERSION=v1.9.2"
set "WHISPER_BIN=%ROOT%\bin\whisper-win-x64\Release\whisper-server.exe"
if exist "%WHISPER_BIN%" (
  echo [whisper] cached: whisper-server.exe
) else (
  echo [whisper] downloading %WHISPER_ASSET% ^(voice-to-text^)
  curl -L --fail --retry 3 -o "%TEMP%\pocketbrain_whisper.zip" "https://github.com/ggml-org/whisper.cpp/releases/download/%WHISPER_VERSION%/%WHISPER_ASSET%"
  if errorlevel 1 (
    echo [whisper] WARN: whisper download failed; voice-to-text will be disabled.
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\backend\extract.ps1" -Zip "%TEMP%\pocketbrain_whisper.zip" -Dest "%ROOT%\bin\whisper-win-x64"
    if errorlevel 1 (
      where tar >nul 2>nul
      if %errorlevel%==0 (
        tar -mxf "%TEMP%\pocketbrain_whisper.zip" -C "%ROOT%\bin\whisper-win-x64" 2>nul
      ) else (
        powershell -NoProfile -Command "Expand-Archive -LiteralPath '%TEMP%\pocketbrain_whisper.zip' -DestinationPath '%ROOT%\bin\whisper-win-x64' -Force"
      )
    )
    del "%TEMP%\pocketbrain_whisper.zip" 2>nul
  )
)
if not exist "%WHISPER_BIN%" (
  rem fallback location: some zips extract flat without a Release/ dir
  set "WHISPER_BIN=%ROOT%\bin\whisper-win-x64\whisper-server.exe"
)

rem --- STT model (whisper.cpp) ----------------------------------------------
set "STT_MODEL_PATH=%ROOT%\models\ggml-base.en.bin"
if exist "%STT_MODEL_PATH%" (
  echo [stt] cached: ggml-base.en.bin
) else (
  echo [stt] downloading ggml-base.en.bin ^(voice-to-text, ~148 MB, first-run^)...
  "%NODE_CMD%" "%ROOT%\backend\download_stt_model.js"
  if errorlevel 1 (
    echo [stt] WARN: STT model download failed; voice-to-text will be disabled.
  )
)

rem --- Model detection/vendoring -----------------------------------------------
set "MODEL_FILE=Qwen3.5-2B-Q4_K_M.gguf"
set "MODEL_PATH=%ROOT%\models\%MODEL_FILE%"
if not exist "%ROOT%\models" mkdir "%ROOT%\models"
if exist "%MODEL_PATH%" (
  echo [model] cached: %MODEL_FILE%
  goto :model_ok
)
echo [model] downloading %MODEL_FILE% (~1.0 GB, first-run only)...
"%NODE_CMD%" "%ROOT%\backend\download_model.js"
if errorlevel 1 (
  echo [model] ERROR: model download failed.
  pause & exit /b 1
)

:model_ok

rem --- Speculative-decoding draft model -----------------------------------------
set "DRAFT_FILE=Qwen3.5-0.8B-Q4_K_M.gguf"
set "DRAFT_PATH=%ROOT%\models\%DRAFT_FILE%"
if not exist "%DRAFT_PATH%" (
  echo [model] downloading %DRAFT_FILE% ^(~0.5 GB, speeds up answers^)...
  call "%NODE_CMD%" "%ROOT%\backend\download_model.js" DRAFT_MODEL
  if errorlevel 1 (
    echo [model] WARN: draft download failed; running without it.
  )
)

rem --- Start backend ----------------------------------------------------------
echo.
echo [pocketbrain] starting backend...
echo [pocketbrain] browser will open at http://127.0.0.1:3000
"%NODE_CMD%" "%ROOT%\backend\server.js"
rem server.js blocks until Ctrl+C; on exit we come back here.
goto :eof
