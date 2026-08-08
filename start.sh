#!/usr/bin/env bash
# PocketBrain launcher for macOS and Linux (aarch64 and x64).
# Same flow as windows.bat: vendor Node if needed, provision llama.cpp/
# whisper.cpp/models for THIS machine, then start the backend.
set -e
cd "$(dirname "$0")"

echo "============================================"
echo " PocketBrain  -  self-contained local LLM on a USB"
echo "============================================"

NODE_CMD=""
if command -v node >/dev/null 2>&1; then
  NODE_CMD="node"
else
  uname_out="$(uname -s)"
  case "$uname_out" in
    Darwin)
      case "$(uname -m)" in
        arm64) NODE_PKG="darwin-arm64" ;;
        x86_64) NODE_PKG="darwin-x64" ;;
      esac
      ;;
    Linux)
      case "$(uname -m)" in
        aarch64|arm64) NODE_PKG="linux-arm64" ;;
        x86_64|amd64) NODE_PKG="linux-x64" ;;
      esac
      ;;
  esac
  if [ -n "$NODE_PKG" ]; then
    NODE_DIR="$PWD/runtime/node-$NODE_PKG"
    NODE_CMD="$NODE_DIR/bin/node"
    if [ ! -x "$NODE_CMD" ]; then
      NODE_VER=v24.19.0
      NODE_URL="https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_PKG.tar.gz"
      NODE_TGZ="$PWD/runtime/node.tar.gz"
      mkdir -p "$PWD/runtime"
      echo "[runtime] vendoring portable Node ($NODE_PKG)..."
      echo "[runtime] downloading $NODE_URL"
      curl -fL --retry 3 -o "$NODE_TGZ" "$NODE_URL" || true
      if [ -s "$NODE_TGZ" ]; then
        tar -xzf "$NODE_TGZ" -C "$PWD/runtime/"
        mv "$PWD/runtime/node-$NODE_VER-$NODE_PKG" "$NODE_DIR"
        rm -f "$NODE_TGZ"
      fi
    fi
  fi
fi
if [ -z "$NODE_CMD" ] || [ ! -x "$NODE_CMD" ]; then
  echo "[runtime] ERROR: Node.js not found. Install Node.js or place the portable build in runtime/."
  exit 1
fi
echo "[runtime] Node ready: $NODE_CMD"

echo "[setup] detecting hardware..."
if ! "$NODE_CMD" backend/launcher.js; then
  echo "[setup] ERROR: provisioning failed. Check the network and try again."
  exit 1
fi

echo
echo "[pocketbrain] starting backend..."
echo "[pocketbrain] browser will open at http://127.0.0.1:3000"
exec "$NODE_CMD" backend/server.js