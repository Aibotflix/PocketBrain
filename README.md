# Stick AI

A self-contained local LLM chat that runs from a single folder — copy the
folder onto a USB drive, plug it into any Windows/macOS/Linux machine, double
click, and chat with a local model. Zero install, no admin rights, no accounts.
Everything runs on the machine you're on; conversations never leave it.

```
Stick-Ai/
├── windows.bat     # double-click on Windows
├── mac.sh          # sh mac.sh  (or chmod +x ./mac.sh && ./mac.sh)
├── linux.sh        # sh linux.sh
├── backend/        # node http server + llama-server supervisor
│   ├── server.js
│   ├── llama.js
│   ├── whisper.js   # voice-to-text (whisper.cpp) supervisor
│   ├── search.js    # web search (Firecrawl Keyless)
│   ├── download.js
│   ├── download_model.js
│   ├── download_stt_model.js
│   └── config.js
├── frontend/       # single index.html, no build step
├── bin/            # per-machine llama/whisper binaries (gitignored)
├── runtime/        # portable node (gitignored)
├── models/         # GGUF model files (gitignored)
└── logs/           # llama-server.log, whisper.log
```

## What it does

- **Chat with a real LLM, fully offline** — a Qwen3.5-2B model runs locally via
  llama.cpp. No cloud, no API key, no signup, no telemetry.
- **Voice input** — speak instead of typing; a local whisper.cpp server turns
  your voice into text. Audio never leaves the machine.
- **Web search (optional, per message)** — toggle 🌐 and answers get grounded
  in real web results (Firecrawl Keyless, no API key) instead of the model
  guessing. The only feature that needs internet.
- **Works on any OS/arch without choosing anything** — the launcher detects
  Windows/macOS/Linux and x64/ARM64 and picks the fitting prebuilt binary:
  Windows: CUDA by driver version, AMD Radeon (HIP), Intel Arc (SYCL), or CPU.
  macOS: Metal on Apple Silicon, CPU on Intel. Linux: CPU build by default, or
  Vulkan if `glxinfo` shows a GPU — no ROCm/CUDA on Linux (portability call,
  see linux.sh). Nothing compiles, nothing installs.

## First run (needs internet once, ~5–15 min)

1. Put the folder on a USB drive (see [Shipping on a USB](#shipping-on-a-usb)).
2. Double-click `windows.bat` (or run `sh mac.sh` / `sh linux.sh`).
3. The launcher downloads into the folder, *only what this machine lacks*:
   - a portable Node.js runtime into `runtime/` (skipped if `node` is on PATH),
   - the matching prebuilt `llama-server` for your OS/GPU into `bin/`,
   - the chat model `Qwen3.5-2B-Q4_K_M.gguf` (~1.2 GB) into `models/`,
   - the whisper STT server + voice model on Windows/Linux (~150 MB).
4. Your browser opens at `http://127.0.0.1:3000`.
5. Click **Start engine** (top right) — first load takes ~30 s — then chat.

All downloads cache in the folder with `.part` resume. Every later run is
fully offline, no launcher step beyond double-click.

## Using it

### Chat
Type in the box, press **Enter** (Shift+Enter = newline). Click **Clear** to
wipe the conversation. The status dot in the corner shows backend health; a
grey "Searching the web…" / "Thinking…" ticker shows the engine is working.

### Voice typing (Windows/Linux)
Click 🎤, speak, click again. The transcript lands in the input box — edit it
if needed, then send. Requires the whisper download from first run; if it
failed, the button stays hidden. macOS voice is not supported (whisper.cpp
publishes no macOS prebuilt binary).

### Web search (grounded answers)
Click 🌐 so it lights up — it stays on until you click it off. While on, every
message gets real search results (top 5) injected as context before the model
answers, so replies cite real sources from today instead of the model's
training data. If offline, the model just answers from memory.
Off by default: recipients who never click 🌐 stay fully offline.

### Installing more models
Drop any `.gguf` file into `models/`, refresh the page, and pick it from the
dropdown in the header (it scans `models/` for `*.gguf` on load). Click
**Start engine** to load the new one. Tips:

- Any GGUF works (LLaMA, Mistral, Gemma, Qwen…), but llama.cpp needs a
  matching `llama-server` — the pinned binary supports all current formats.
- Bigger isn't better on a USB: 2B–8B Q4 quantizations fit the 4 GB stick and
  run on CPU. Larger models (13B+) need a discrete GPU.
- The STT voice model is separate: `models/ggml-base.en.bin` (don't rename).

## Turning it off

- **Stop button** (top right, next to Clear) — stops the engine, kills the
  local servers, and closes the launcher window.
- Or close the launcher console window / press **Ctrl+C** there. Same thing.
- Closing only the browser tab does **not** stop the app — the servers keep
  running until one of the two above.

## How it works

- Three local processes, all bound to `127.0.0.1` (loopback only — nothing is
  exposed to your network): the Node backend on port 3000 (serves the page),
  `llama-server` on 8081 (the model), and whisper-server on 8082 (voice, only
  when used).
- `server.js` spawns llama-server, waits for `/health`, then serves the
  frontend and proxies chat (`/api/chat` → SSE tokens).
- Everything is relative to the app folder; nothing is written outside it.
  That's the whole USB-portability contract.
- Windows runs llama-server with `--no-mmap` because memory-mapped GGUFs on
  FAT/exFAT page-fault to death on a USB stick.

## Minimum USB size

**Use a 4 GB stick** (formats to ~3.7 GB usable). The clean folder is ~1.4 GB
and first-run downloads for any machine fit with room to spare:

```
models/Qwen3.5-2B-Q4_K_M.gguf    ~1.2 GB   chat model
models/ggml-base.en.bin          ~141 MB   voice model
backend + frontend + launchers   ~60 KB
```
Recipient-side first-run downloads (cached on *their* machine, not the stick),
actual zip sizes from the pinned releases (llama.cpp b10284, whisper.cpp v1.9.2):

| Machine | Downloads | Zip size |
|---|---|---|
| Windows, CPU (x64 / ARM64) | `win-cpu-x64` / `win-cpu-arm64` | 17.5 / 11.6 MB |
| Windows + NVIDIA | `win-cuda-12.4-x64` (driver <570) or `win-cuda-13.3-x64` (≥570) **+ cudart sidecar** | 238.8 + 373.3 MB = **612 MB** / 139.7 + 372.9 MB = **513 MB** |
| Windows + AMD Radeon | `win-hip-radeon-x64` | 309.6 MB |
| Windows + Intel Arc | `win-sycl-x64` | 114.4 MB |
| macOS Apple Silicon | `macos-arm64` (Metal) | 10.5 MB |
| macOS Intel | `macos-x64` (CPU) | 10.7 MB |
| Linux, CPU (x64 / ARM64) | `ubuntu-x64` / `ubuntu-arm64` | 15.7 / 12.7 MB |
| Linux + Vulkan GPU (AMD etc.) | `ubuntu-vulkan-x64` / `ubuntu-vulkan-arm64` | 30.9 / 25.3 MB |
| Voice (Windows/Linux only) | whisper `x64` / `ubuntu-x64` / `ubuntu-arm64` | 7.8 / 9.1 / 4.4 MB |

Notes: Linux deliberately fetches the CPU build even when `nvidia-smi` is
present — CUDA binaries bundle runtime libs that break USB portability (see
`linux.sh`). Linux AMD uses the Vulkan build, not the ROCm one. macOS has no
voice support because whisper.cpp ships no macOS binary. The biggest first-run
download is Windows+NVIDIA at ~612 MB; everything else is under 310 MB.

## Shipping on a USB

Copy these — the machine-independent pieces:

```
backend/   frontend/   test/
windows.bat  linux.sh  mac.sh
models/                # the GGUF model + ggml-base.en.bin
```

Do **not** copy `bin/` or `runtime/` — they're per-machine caches. The
recipient's first run auto-detects their OS/GPU and downloads the matching
binary. Copying a `bin/` built for a different GPU wastes ~1.3 GB and gets
replaced by re-detection anyway.

## Requirements

- USB 4 GB or larger (see above).
- An x64 or ARM64 CPU with AVX2 (x64) — real GPU builds want a discrete GPU.
- ~2 GB free space locally for model + binaries.
- Internet only on the very first run of a given machine.
- No admin rights, no installers, no Node.js needed (vendored automatically).

## Tested on

Only one machine has run this so far:

- **Windows 11, x64, CPU-only** — `windows.bat` end to end: first-run
  downloads, backend + llama-server + whisper-server startup, chat, voice
  transcription, web search.

Everything else is **code-reviewed against the release asset lists, not
executed**: macOS and Linux launchers (`mac.sh`, `linux.sh`), ARM64, and all
GPU builds (NVIDIA CUDA, AMD Radeon/HIP, Intel SYCL, Vulkan, Metal). If you
run it on one of those, expect the first-run setup to be the risk point —
a failure there just re-runs after deleting `bin/<variant>/`.

## Troubleshooting

- **No response / engine won't start**: check `logs/llama-server.log`. A
  non-zero code usually means the GPU build doesn't match your drivers —
  delete `bin/<variant>/` and re-run to re-detect, or force the CPU build with
  `AIUSB_VARIANT=win-cpu-x64` (Windows only) before launching.
- **Model answers with "thinking…" noise**: Stick AI starts llama-server with
  `--reasoning off` so Qwen3.5 answers directly. If you enable reasoning,
  reasoning tokens stream via `delta.reasoning_content` (dimmed in the UI)
  and the final answer in `delta.content`.
- **Download failed**: launcher uses `curl` (bundled on Windows 10+, present
  on macOS/Linux). Just re-run — downloads resume from the `.part` file.
- **Slower than expected on Windows**: that's the `--no-mmap` trade-off;
  dramatically faster on a USB stick, more RAM used.
- **Windows AMD Radeon**: the HIP build usually works driver-free; if the log
  shows a HIP/ROCm load error, delete `bin/win-hip-radeon-x64/` and re-run to
  fall back to CPU.
- **Voice button missing**: whisper download failed on first run — delete
  `bin/whisper-*` and `models/ggml-base.en.bin` and re-run the launcher.
