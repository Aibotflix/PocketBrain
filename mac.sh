#!/usr/bin/env bash
# PocketBrain launch for macOS. Vendors a portable Node if needed, downloads the
# matching llama.cpp prebuilt binary (Metal on Arm, CPU elsewhere), fetches a
# small GGUF model, then starts the backend.
# Run: sh mac.sh   (double-clickable via osascript wrapper too)

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "============================================"
echo " PocketBrain  -  self-contained local LLM on a USB"
echo "   macOS"
echo "============================================"
echo

# --- Portable Node ----------------------------------------------------------
NODE_CMD=""
if command -v node >/dev/null 2>&1; then
  NODE_CMD="node"
else
  NODE_DIR="$ROOT/runtime/node-mac"
  NODE_CMD="$NODE_DIR/bin/node"
  if [ ! -x "$NODE_CMD" ]; then
    echo "[runtime] Node.js not found. Vendoring portable Node (first-run)..."
    mkdir -p "$ROOT/runtime"
    ARCH="$(uname -m)"
    case "$ARCH" in
      arm64|aarch64) NODE_OS="darwin-arm64" ;;
      x86_64|amd64)  NODE_OS="darwin-x64" ;;
      *) echo "[runtime] unsupported arch: $ARCH"; exit 1 ;;
    esac
    VER="v24.19.0"
    URL="https://nodejs.org/dist/$VER/node-$VER-$NODE_OS.tar.gz"
    TGZ="$ROOT/runtime/node.tgz"
    echo "[runtime] downloading $URL"
    curl -fL --retry 3 -o "$TGZ" "$URL"
    rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
    tar -xzf "$TGZ" -C "$NODE_DIR" --strip-components=1
    rm -f "$TGZ"
  fi
fi
echo "[runtime] node: $($NODE_CMD --version)"

# --- llama.cpp binary -------------------------------------------------------
LLAMA_RELEASE="b10284"
BIN_OUT="$ROOT/bin"
mkdir -p "$BIN_OUT"

ARCH="$(uname -m)"
ASSET_DIR=""
VARIANT=""

if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    VARIANT="macos-arm64"
  else
    VARIANT="macos-x64"
  fi
fi

ASSET_DIR="$BIN_OUT/$VARIANT"
ASSET="llama-b10284-bin-$VARIANT.tar.gz"
LLAMA_BIN="$ASSET_DIR/llama-server"
URL="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_RELEASE/$ASSET"

# The stick moves between machines: keep ONLY this machine's chosen variant.
# A stale build from yesterday's machine would otherwise get preferred by the
# backend (GPU variants sort first) and silently run on the wrong hardware.
for d in "$BIN_OUT"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  case "$name" in
    "$VARIANT"|whisper*) ;;
    *) rm -rf "$d" ;;
  esac
done

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

# --- Model ------------------------------------------------------------------
MODEL_FILE="Qwen3.5-2B-UD-Q4_K_XL.gguf"
mkdir -p "$ROOT/models"
if [ -f "$ROOT/models/$MODEL_FILE" ]; then
  echo "[model] cached: $MODEL_FILE"
else
  echo "[model] downloading $MODEL_FILE (~1.3 GB, first-run only)..."
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
