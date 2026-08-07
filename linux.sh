#!/usr/bin/env bash
# PocketBrain launch for Linux. Detects GPU (NVIDIA/AMD), downloads the matching
# prebuilt llama.cpp binary from GitHub releases, vendors a portable Node if
# needed, fetches a small GGUF model, then starts the backend.
# Run: sh linux.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "============================================"
echo " PocketBrain  -  self-contained local LLM on a USB"
echo "   Linux"
echo "============================================"
echo

# --- Portable Node ----------------------------------------------------------
NODE_CMD=""
if command -v node >/dev/null 2>&1; then
  NODE_CMD="node"
else
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)  NA="x64" ;;
    aarch64|arm64) NA="arm64" ;;
    *) echo "[runtime] unsupported arch: $ARCH"; exit 1 ;;
  esac
  NODE_DIR="$ROOT/runtime/node-linux-$NA"
  NODE_CMD="$NODE_DIR/bin/node"
  if [ ! -x "$NODE_CMD" ]; then
    echo "[runtime] Node.js not found. Vendoring portable Node (first-run)..."
    mkdir -p "$ROOT/runtime"
    VER="v24.19.0"
    URL="https://nodejs.org/dist/$VER/node-$VER-linux-$NA.tar.xz"
    XZ="$ROOT/runtime/node.tar.xz"
    echo "[runtime] downloading $URL"
    curl -fL --retry 3 -o "$XZ" "$URL"
    rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
    tar -xJf "$XZ" -C "$NODE_DIR" --strip-components=1
    rm -f "$XZ"
  fi
fi
echo "[runtime] node: $($NODE_CMD --version)"

# --- llama.cpp binary -------------------------------------------------------
LLAMA_RELEASE="b10284"
BIN_OUT="$ROOT/bin"; mkdir -p "$BIN_OUT"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH2="x64" ;;
  aarch64|arm64) ARCH2="arm64" ;;
  *) echo "[bin] unsupported arch: $ARCH"; exit 1 ;;
esac

VARIANT=""
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[bin] NVIDIA GPU detected (nvidia-smi) -> CPU fallback binary"
  echo "[bin]   (CUDA builds bundle ROCm/OpenCL runtime deps that break USB portability;"
  echo "[bin]    CPU/AVX2 binary is small and works offline without CUDA libs installed.)"
  VARIANT="ubuntu-x64"
elif command -v glxinfo >/dev/null 2>&1; then
  if glxinfo -B 2>/dev/null | grep -qiE 'radeon|amd'; then
    echo "[bin] AMD GPU detected -> Vulkan binary"
    VARIANT="ubuntu-vulkan-$ARCH2"
  else
    echo "[bin] Vulkan-capable GPU detected -> Vulkan binary"
    VARIANT="ubuntu-vulkan-$ARCH2"
  fi
else
  echo "[bin] No GPU tooling detected -> CPU binary$([ "$ARCH2" = "arm64" ] && echo " (arm64)")"
  if [ "$ARCH2" = "arm64" ]; then VARIANT="ubuntu-arm64"; else VARIANT="ubuntu-x64"; fi
fi

# ubuntu-vulkan-arm64 uses ARCH2; ubuntu-x64 and ubuntu-vulkan-x64 are fixed.
# ubuntu-arm64 is the modern CPU build only for aarch64 (still x86_64-forced).
case "$VARIANT" in
  ubuntu-x64)        ASSET="llama-b10284-bin-ubuntu-x64.tar.gz" ;;
  ubuntu-arm64)      ASSET="llama-b10284-bin-ubuntu-arm64.tar.gz" ;;
  ubuntu-vulkan-x64) ASSET="llama-b10284-bin-ubuntu-vulkan-x64.tar.gz" ;;
  ubuntu-vulkan-arm64) ASSET="llama-b10284-bin-ubuntu-vulkan-arm64.tar.gz" ;;
esac

ASSET_DIR="$BIN_OUT/$VARIANT"
LLAMA_BIN="$ASSET_DIR/llama-server"
URL="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_RELEASE/$ASSET"

if [ -x "$LLAMA_BIN" ]; then
  echo "[bin] cached: $VARIANT"
else
  echo "[bin] downloading $ASSET"
  mkdir -p "$ASSET_DIR"
  curl -fL --retry 3 -o "$ASSET_DIR/$ASSET" "$URL"
  tar -xzf "$ASSET_DIR/$ASSET" -C "$ASSET_DIR"
  rm -f "$ASSET_DIR/$ASSET"
  chmod +x "$ASSET_DIR"/* 2>/dev/null || true
fi
if [ ! -x "$LLAMA_BIN" ]; then
  echo "[bin] ERROR: llama-server missing after extract"; exit 1
fi
echo "[bin] ready: $VARIANT"

# --- whisper.cpp (STT) binary -------------------------------------------------
WHISPER_VER="v1.9.2"
WHISPER_ASSET_DIR="$BIN_OUT/whisper-linux-$ARCH2"
mkdir -p "$WHISPER_ASSET_DIR"
if find "$WHISPER_ASSET_DIR" -name whisper-server -type f 2>/dev/null | grep -q .; then
  echo "[whisper] cached: whisper-server"
else
  echo "[whisper] downloading whisper-bin-ubuntu-$ARCH2.tar.gz (voice-to-text)"
  curl -fL --retry 3 -o "$WHISPER_ASSET_DIR/whisper.tar.gz" \
    "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VER/whisper-bin-ubuntu-$ARCH2.tar.gz" || {
    echo "[whisper] WARN: whisper download failed; voice-to-text will be disabled."
  }
  if [ -f "$WHISPER_ASSET_DIR/whisper.tar.gz" ]; then
    tar -xzf "$WHISPER_ASSET_DIR/whisper.tar.gz" -C "$WHISPER_ASSET_DIR" || true
    rm -f "$WHISPER_ASSET_DIR/whisper.tar.gz"
    chmod +x "$WHISPER_ASSET_DIR"/**/whisper-server "$WHISPER_ASSET_DIR"/whisper-server 2>/dev/null || true
    find "$WHISPER_ASSET_DIR" -name whisper-server -type f -exec chmod +x {} + 2>/dev/null || true
  fi
fi

# --- STT model --------------------------------------------------------------
STT_MODEL="ggml-base.en.bin"
if [ -f "$ROOT/models/$STT_MODEL" ]; then
  echo "[stt] cached: $STT_MODEL"
else
  echo "[stt] downloading $STT_MODEL (~148 MB, first-run)..."
  "$NODE_CMD" "$ROOT/backend/download_stt_model.js" || echo "[stt] WARN: STT model download failed; voice-to-text will be disabled."
fi

# --- Model ------------------------------------------------------------------
MODEL_FILE="Qwen3.5-2B-UD-Q4_K_XL.gguf"
mkdir -p "$ROOT/models"
if [ -f "$ROOT/models/$MODEL_FILE" ]; then
  echo "[model] cached: $MODEL_FILE"
else
  echo "[model] downloading $MODEL_FILE (~1.0 GB, first-run only)..."
  "$NODE_CMD" "$ROOT/backend/download_model.js"
fi

# Speculative-decoding draft (~0.5 GB). Same family as the main model, so
# llama-server auto-uses it for ~1.3-1.5x faster answers. Optional: if this
# download fails, the app still works, just without the speedup.
DRAFT_FILE="Qwen3.5-0.8B-Q4_K_M.gguf"
if [ -f "$ROOT/models/$DRAFT_FILE" ]; then
  echo "[model] cached: $DRAFT_FILE"
else
  echo "[model] downloading $DRAFT_FILE (~0.5 GB, speeds up answers)..."
  "$NODE_CMD" "$ROOT/backend/download_model.js" DRAFT_MODEL || echo "[model] WARN: draft download failed; running without it."
fi

# --- Start backend ----------------------------------------------------------
echo
echo "[pocketbrain] starting backend..."
echo "[pocketbrain] open http://127.0.0.1:3000 in your browser"
exec "$NODE_CMD" "$ROOT/backend/server.js"
