# PocketBrain

**The AI you carry in your pocket — plug in, double-click, talk. Free. Private. Offline.**

Plug PocketBrain into any Windows, macOS, or Linux computer, double-click, and
chat with a real LLM. No accounts, no installs, no cloud, no monthly bill —
the model runs entirely on the machine you're sitting at. Your conversations
never leave that machine, and there is no telemetry to leave it with. The only
thing that ever touches the network is an optional web-search toggle, and even
that goes *out*, never in about you.

| | |
|---|---|
| 🆓 **Free forever** | $0, full stop — no signup, no API key, no subscription, no metering, no "pro tier" |
| 🎙️ **Just talk** | Speak like you'd talk to a friend — PocketBrain types it, instantly. Audio never leaves the machine |
| ⚡ **Fast** | ~1.3–1.5x faster with speculative decoding (Qwen3.5-2B + 0.8B draft) |
| 📦 **Pocket-sized** | ~2 GB total, fits on a consumer 4 GB USB stick — carry it in your pocket, run it anywhere |
| 📋 **Copy in one tap** | Every AI answer has a copy button — grab it, paste it, done |
| 🌐 **Grounded** | Optional web search (keyless Firecrawl, no API key) — answers from today, not training data |

| | |
|---|---|
| 💻 **Any computer** | Windows · macOS · Linux — auto-detected at launch, no choosing |
| 🧮 **Any chip** | x64 · ARM64 — picks the matching binary, no flags |
| 🎯 **Any GPU** | NVIDIA · AMD Radeon · Intel Arc · Apple Metal · CPU-only — all auto-routed |

| | |
|---|---|
| 🔒 **No installs** | Nothing gets written outside the app folder |
| 🔑 **No accounts** | No login, no signup, no email — anywhere in the flow |
| ☁️ **No cloud** | No backend, no telemetry, no phone-home |
| 🤫 **No traces** | Conversations never leave the stick |

---

## Get it running (no technical skills needed)

1. **Grab the files.** On this page (GitHub), click the green **Code** button,
   then **Download ZIP**. Your computer saves a file called
   `PocketBrain-main.zip`.
2. **Plug in a USB stick** (4 GB or bigger) — reformat it to **exFAT** first if
   you can (right-click → Format… on Windows, Disk Utility on macOS). exFAT is
   the one filesystem all three OSes read and write natively.
3. **Unzip onto the USB.** Right-click the ZIP → "Extract All…" (Windows) or
   double-click it (Mac/Linux) → put the resulting `PocketBrain-main` folder on
   the USB drive.
4. **Start it — depending on your computer:**

   - **Windows:** double-click the file named `windows.bat`.
   - **Mac:** open the **Terminal** app (Spotlight → type "Terminal"), type
     `sh ` (a space at the end), then drag the file named `mac.sh` from the
     USB onto the Terminal window, then press Enter.
   - **Linux:** open a terminal and run `sh linux.sh` (or drag the `linux.sh`
     file onto it like the Mac step).

   A window opens and starts downloading the AI parts. It needs internet and
   takes **5–15 minutes the first time**. Let it finish — don't close the
   window.
5. **Chat.** Your browser opens on its own. Click **Start engine** (top right),
   wait ~30 seconds, then type a message and press Enter.

That's it. Every later run is identical, just plug in and start — it works
**without internet**. (The black window must stay open while you chat; the Stop
button in the app closes it for you.)

**You need internet only the first time on each computer.** Nothing is
uploaded, no account is needed, no telemetry is sent.

---

## What it does

- **Chat with a real LLM, fully offline** — a Qwen3.5-2B model runs locally via
  llama.cpp, accelerated by speculative decoding: a small Qwen3.5-0.8B "draft"
  model pre-guesses tokens and the 2B accepts/rejects them in batches, giving
  ~1.3–1.5x faster answers with identical quality. No cloud, no API key, no
  signup, no telemetry.
- **Voice input** — speak instead of typing; a local whisper.cpp server turns
  your voice into text. Audio never leaves the machine.
- **Web search (opt-in, per message)** — toggle 🌐 and answers get grounded in
  real web results (Firecrawl Keyless, no API key) instead of the model
  guessing. The only feature that needs internet.
- **Copy any reply** — each AI answer has a Copy button; one click puts it on
  your clipboard as plain text.
- **Works on any OS/arch without choosing anything** — the launcher detects
  Windows/macOS/Linux and x64/ARM64 and picks the fitting prebuilt binary:
  Windows: CUDA by driver version, AMD Radeon (HIP), Intel (SYCL), or CPU.
  macOS: Metal on Apple Silicon, CPU on Intel. Linux: CPU by default, or
  Vulkan if `glxinfo` shows a GPU. Nothing compiles, nothing installs.

## First run (needs internet once, ~5–15 min)

1. Put the folder on a USB drive (see [Shipping on a USB](#shipping-on-a-usb)).
2. Double-click `windows.bat` (or run `sh mac.sh` / `sh linux.sh`).
3. The launcher downloads into the folder, *only what this machine lacks*:
   - a portable Node.js runtime into `runtime/` (skipped if `node` is on PATH),
   - the matching prebuilt `llama-server` for your OS/GPU into `bin/`,
   - the chat model `Qwen3.5-2B-UD-Q4_K_XL.gguf` (~1.3 GB) into `models/`,
   - the speculative-decoding draft `Qwen3.5-0.8B-Q4_K_M.gguf` (~0.5 GB) into
     `models/` — reused automatically for faster answers on every later run,
   - the whisper STT server + voice model on Windows/Linux (~148 MB).
4. Your browser opens at `http://127.0.0.1:3000`.
5. Click **Start engine** (top right) — first load takes ~30 s — then chat.

All downloads cache in the folder with `.part` resume. Every later run is
fully offline, no launcher step beyond double-click.

---

## Using it

### Chat
Type in the box, press **Enter** (Shift+Enter = newline). Click **Clear** to
wipe the conversation. The status dot in the corner shows backend health; a
grey "Searching the web…" / "Thinking…" ticker shows the engine is working.

### Voice typing (Windows/Linux)
Talk to it like you'd talk to a friend. Click 🎤, say what's on your mind, click
🎤 again — PocketBrain types it out for you in the input box. Give it a once-over,
then press Enter to send. No assistant to wake, nothing to train — the model just
listens while you talk, and the audio never leaves the machine. Voice needs the
whisper model from first run; if that download failed, the button stays hidden.
macOS voice is not supported (whisper.cpp publishes no macOS prebuilt binary).

### Web search (grounded answers)
Web search is **off by default** — the model answers from memory unless you
turn it on. Click 🌐 to switch it on (per message); the toggle is remembered
for the session. When on, the top results for your message are injected as
context before the model answers, so replies cite real sources from today
instead of the model's training data. If the machine is offline,
search fails silently and the model answers from memory either way.

### Installing more models
Drop any `.gguf` file into `models/`, refresh the page, and pick it from the
dropdown in the header (it scans `models/` for `*.gguf` on load; the draft
model is hidden from the picker by design). Click **Start engine** to load
the new one. Tips:

- Any GGUF works (LLaMA, Mistral, Gemma, Qwen…), and llama.cpp supports all
  current formats via the pinned binary.
- Bigger isn't better on a USB: 2B–8B Q4 quantizations fit the 4 GB stick and
  run on CPU. Larger models (13B+) need a discrete GPU.
- **Quality upgrade:** `node backend/download_model.js MODEL_4B` grabs
  Qwen3.5-4B Q4_K_M (~2.3 GB) — noticeably smarter, still fast on CPU, and
  the 0.8B draft accelerates it too. Delete the file to go back.
- The draft (`Qwen3.5-0.8B-Q4_K_M.gguf`) is part of the system — keep it.
  It's what makes answers ~1.3–1.5x faster, and the launcher re-downloads it
  automatically if it's ever missing. Don't delete it; never pick it as the
  chat model.
- The STT voice model is separate: `models/ggml-base.en.bin` (don't rename).

## Turning it off

- **Stop button** (top right, next to Clear) — stops the engine, kills the
  local servers, and closes the launcher window.
- Or close the launcher window / press **Ctrl+C** there. Same thing.
- Closing only the browser tab does **not** stop the app — the servers keep
  running until one of the two above.

---

## How it works

- Three local processes, all bound to `127.0.0.1` (loopback only — nothing is
  exposed to your network): the Node backend on port 3000 (serves the page),
  `llama-server` on 8081 (the model), and whisper-server on 8082 (voice, only
  when used).
- `server.js` spawns llama-server, waits for `/health`, then serves the
  frontend and proxies chat (`/api/chat` → SSE tokens).
- Everything is relative to the app folder; nothing is written outside it.
  That's the whole USB-portability contract.
- On Windows, the model loads with `--load-mode none` (no mmap; model fully in
  RAM) because memory-mapped GGUFs on FAT/exFAT page-fault to death on a USB
  stick.
- If `models/Qwen3.5-0.8B-Q4_K_M.gguf` is present, llama-server also gets
  `--model-draft` — speculative decoding. The small model guesses tokens, the
  main model validates them in batches: same output quality, ~1.3–1.5x speed.

---

## Minimum USB size

**Use a 4 GB stick** (formats to ~3.7 GB usable). Reformat it to **exFAT** —
the one filesystem Windows, macOS, and Linux all read and write natively. FAT32
is fine too (every file here is under the 4 GB cap), so a stick that's already
formatted works as-is. The clean folder is ~2.0 GB
and first-run downloads for any machine fit with room to spare:

```
models/Qwen3.5-2B-UD-Q4_K_XL.gguf  ~1.3 GB   chat model
models/Qwen3.5-0.8B-Q4_K_M.gguf  ~0.5 GB   speedup draft (speculative decoding)
models/ggml-base.en.bin          ~148 MB   voice model
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

Notes: Linux intentionally fetches the CPU build even when `nvidia-smi` is
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

---

## Requirements

- USB 4 GB or larger (see above).
- An x64 or ARM64 CPU with AVX2 (x64) — real GPU builds want a discrete GPU.
- ~2.5 GB free space locally for models + binaries.
- Internet only on the very first run of a given machine.
- No admin rights, no installers, no Node.js needed (vendored automatically).

## Support

If PocketBrain saves you hours of setup, or you just want to support more
projects like this:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/aibotflix)

---

## Tested on

Only one machine has run this so far:

- **Windows 11, x64, CPU-only** — `windows.bat` end to end: first-run
  downloads, backend + llama-server + whisper-server startup, chat, voice
  transcription, web search.

Everything else is **code-reviewed against the release asset lists, not
executed**: macOS and Linux launchers (`mac.sh`, `linux.sh`), ARM64, and all
GPU builds (NVIDIA CUDA, AMD Radeon/HIP, Intel SYCL, Vulkan, Metal). If you
do, expect the first-run setup to be the risk point — a failure there just
deletes `bin/<variant>/` and re-runs.

## Troubleshooting

- **No response / engine won't start**: check `logs/llama-server.log`. A
  non-zero code usually means the GPU build doesn't match your drivers —
  delete `bin/<variant>/` and re-run to re-detect, or force the CPU build with
  `POCKETBRAIN_VARIANT=win-cpu-x64` (Windows only) before launching.
- **Model answers with "thinking…" noise**: PocketBrain starts llama-server with
  `--reasoning off` so Qwen3.5 answers directly. If you re-enable reasoning,
  reasoning tokens stream via `delta.reasoning_content` (dimmed in the UI)
  and the final answer in `delta.content`.
- **Download failed**: launcher uses `curl` (bundled on Windows 10+, present
  on macOS/Linux). Just re-run — downloads resume from the `.part` file.
- **Slower than expected on Windows**: that's the no-mmap trade-off; loading
  the model fully into RAM instead of memory-mapping the file means no USB
  page-fault stalls, at the cost of more RAM used.
- **Windows AMD Radeon**: the HIP build usually works driver-free; if the log
  shows a HIP/ROCm load error, delete `bin/win-hip-radeon-x64/` and re-run to
  fall back to CPU.
- **Voice button missing**: whisper download failed on first run — delete
  `bin/whisper-*` and `models/ggml-base.en.bin` and re-run the launcher.