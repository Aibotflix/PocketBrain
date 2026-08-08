// Cross-platform provisioning: detects OS/GPU/CPU, downloads the right
// llama.cpp + whisper.cpp assets, keeps the CPU build as fallback, then
// ensures the models exist. Run: node backend/launcher.js
//
// Official asset matrix (llama.cpp b10284, whisper.cpp v1.9.2):
//   llama-b<RELEASE>-bin-win-cpu-x64.zip | win-cpu-arm64 | win-vulkan-x64
//     | win-cuda-12.4/13.3-x64 (+cudart-llama-bin-...) | win-hip-radeon-x64
//     | win-sycl-x64 | win-opencl-adreno-arm64
//   llama-b<RELEASE>-bin-macos-arm64.tar.gz | macos-x64.tar.gz
//   llama-b<RELEASE>-bin-ubuntu-(x64|arm64|-vulkan-x64|-vulkan-arm64|-rocm-... ) | .tar.gz
//   whisper-bin-(x64|Win32).zip | whisper-bin-ubuntu-(x64|arm64).tar.gz
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { APP_ROOT, BIN_DIR, MODELS_DIR, LLAMA_RELEASE, WHISPER_RELEASE } = require("./config");
const { download, downloadModel } = require("./download");

const isWin = os.platform() === "win32";

// ---------------------------------------------------------------- detection

// Windows: real GPU adapter names (skip Microsoft/VM placeholders).
function winGpuNames() {
  const r = spawnSync("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
const DUMMY_GPU = /Microsoft Basic|Basic Display|Basic Render|Virtual|VMware|VirtualBox|QEMU|Standard VGA/i;

function nvidiaDriverMajor() {
  const r = spawnSync("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"],
    { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (r.status !== 0) return null;
  const line = (r.stdout || "").trim().split("\n")[0] || "";
  const m = line.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function hasLinuxGpu() {
  try {
    const r = spawnSync("lspci", ["-nn"], { encoding: "utf8", timeout: 15_000 });
    if (r.status !== 0) return false;
    return /VGA compatible controller|3D controller|Display controller/i.test(r.stdout) &&
      !DUMMY_GPU.test(r.stdout);
  } catch { return false; }
}

// Returns { primary, fallback } variant names. fallback = CPU build kept
// side-by-side so a GPU that starts fine but dies at runtime is recovered.
function detectVariants() {
  const forced = process.env.POCKETBRAIN_VARIANT;
  if (forced) return { primary: forced, fallback: "cpu" };

  const p = process.platform;
  if (p === "win32") {
    if (process.arch !== "x64") return { primary: "win-cpu-arm64", fallback: null };
    const drv = nvidiaDriverMajor();
    if (drv !== null) {
      const v = drv >= 570 ? "win-cuda-13.3-x64" : "win-cuda-12.4-x64";
      return { primary: v, fallback: "win-cpu-x64" };
    }
    const names = winGpuNames().join(" ");
    if (/Radeon (RX|Pro)\b|Radeon(RX)? PRO|Radeon VII/i.test(names)) {
      return { primary: "win-hip-radeon-x64", fallback: "win-cpu-x64" };
    }
    if (/\bArc\b|Iris/i.test(names)) {
      return { primary: "win-sycl-x64", fallback: "win-cpu-x64" };
    }
    if (names && !DUMMY_GPU.test(names)) {
      return { primary: "win-vulkan-x64", fallback: "win-cpu-x64" };
    }
    return { primary: "win-cpu-x64", fallback: null };
  }
  if (p === "darwin") {
    // macos-arm64 = Apple Silicon (Metal). No GPU build for Intel Macs.
    return { primary: process.arch === "arm64" ? "macos-arm64" : "macos-x64", fallback: null };
  }
  if (p === "linux") {
    if (process.arch !== "x64") return { primary: "ubuntu-" + process.arch, fallback: null };
    if (hasLinuxGpu()) return { primary: "ubuntu-vulkan-x64", fallback: "ubuntu-x64" };
    return { primary: "ubuntu-x64", fallback: null };
  }
  throw new Error("Unsupported platform: " + p + "/" + process.arch);
}

function whisperAsset() {
  const p = process.platform;
  if (p === "win32" && process.arch === "x64") return "whisper-bin-x64.zip";
  if (p === "win32") return null; // no official arm64 whisper asset; STT off
  if (p === "linux") return "whisper-bin-ubuntu-" + (process.arch === "arm64" ? "arm64" : "x64") + ".tar.gz";
  return null; // no official macOS whisper in v1.9.2; STT off
}

// ---------------------------------------------------------------- install

function llamaAssetUrl(variant) {
  const ext = isWin ? "zip" : "tar.gz";
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-${variant}.${ext}`;
}
function whisperAssetUrl(name) {
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${name}`;
}
function cudaAssetUrl(variant) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/cudart-llama-bin-${variant}.zip`;
}

// Extract into dir. Windows zip: tar with -m (exFAT can't restore zip
// timestamps; without -m bsdtar "Can't restore time" and exits nonzero
// even though files extracted fine). If bsdtar is absent, PowerShell
// Expand-Archive as fallback. Needs a real .zip/.tar.gz extension -
// PowerShell keys off the file name.
function extract(archive, dir) {
  const isTar = archive.endsWith(".tar.gz");
  if (!isWin) {
    const r = spawnSync("tar", ["-xzf", archive, "-C", dir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar extract failed for ${archive}`);
    return;
  }
  const r = spawnSync("tar", ["-xmf", archive, "-C", dir], { stdio: "inherit" });
  if (r.status === 0) return;
  const r2 = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`],
    { stdio: "inherit", windowsHide: true });
  if (r2.status !== 0) throw new Error(`extract failed: ${archive}`);
}

function llamaBins(varDir) {
  const exe = isWin ? "llama-server.exe" : "llama-server";
  const dir = path.join(BIN_DIR, varDir);
  const found = [];
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === exe) found.push(p);
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

async function ensureLlama(variant) {
  if (llamaBins(variant).length > 0) {
    console.log(`[bin] cached: ${variant}`);
    return;
  }
  fs.mkdirSync(path.join(BIN_DIR, variant), { recursive: true });
  const ext = isWin ? "zip" : "tar.gz";
  const zip = path.join(os.tmpdir(), `pocketbrain_${variant}.${ext}`);
  const url = llamaAssetUrl(variant);
  console.log(`[bin] downloading ${path.basename(url)}`);
  try {
    await download(url, zip);
    extract(zip, path.join(BIN_DIR, variant));
    if (/win-cuda-/.test(variant)) {
      const cu = path.join(os.tmpdir(), `pocketbrain_cudart_${variant}.zip`);
      console.log(`[bin] downloading cudart-llama-bin-${variant}.zip`);
      try {
        await download(cudaAssetUrl(variant), cu);
        extract(cu, path.join(BIN_DIR, variant));
      } catch (e) {
        console.log(`[bin] WARN: cudart failed (${e.message}); falls back to CPU on failure.`);
      } finally { try { fs.unlinkSync(cu); } catch {} }
    }
  } finally { try { fs.unlinkSync(zip); } catch {} }
  if (llamaBins(variant).length === 0) {
    console.log(`[bin] ERROR: llama-server missing in ${variant} after extract`);
    process.exitCode = 1;
  }
}

async function ensureWhisper(name) {
  const dir = path.join(BIN_DIR, "whisper-" + (isWin ? "win" : "ubuntu") + "-" + (process.arch === "arm64" ? "arm64" : "x64"));
  const exe = isWin ? "whisper-server.exe" : "whisper-server";
  const hasBin = fs.existsSync(dir) && (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; }
      else if (e.name === exe) return true;
    }
    return false;
  })(dir);
  if (hasBin) { console.log(`[whisper] cached: ${name}`); return; }
  const zip = path.join(os.tmpdir(), "pocketbrain_" + name);
  console.log(`[whisper] downloading ${name}`);
  try {
    await download(whisperAssetUrl(name), zip);
    fs.mkdirSync(dir, { recursive: true });
    extract(zip, dir);
  } catch (e) {
    console.log(`[whisper] WARN: download failed (${e.message}); STT disabled.`);
  } finally { try { fs.unlinkSync(zip); } catch {} }
}

// Keep whisper + chosen variants (+ CPU fallback); everything else from
// another machine is stale on a portable stick - remove it.
function prune(keep) {
  if (!fs.existsSync(BIN_DIR)) return;
  console.log("[bin] checking local builds for this machine...");
  for (const e of fs.readdirSync(BIN_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (/whisper/.test(e.name) || keep.has(e.name)) continue;
    console.log(`[bin] removing stale build from another machine: ${e.name}`);
    fs.rmSync(path.join(BIN_DIR, e.name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const { primary, fallback } = detectVariants();
  console.log(`[bin] platform: ${process.platform}/${process.arch} -> ${primary}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const keep = new Set([primary]);
  await ensureLlama(primary);
  if (fallback && fallback !== "cpu" && fallback !== primary) {
    keep.add(fallback);
    await ensureLlama(fallback);
  } else if (!fallback) {
    // CPU-only machine: nothing extra to fetch.
  }
  prune(keep);

  const w = whisperAsset();
  if (w) {
    await ensureWhisper(w);
    try { await downloadModel("WHISPER_MODEL"); } catch (e) {
      console.log(`[stt] WARN: model download failed (${e.message}); STT disabled.`);
    }
  }

  await downloadModel(); // default LLM
  try { await downloadModel("DRAFT_MODEL"); } catch (e) {
    console.log(`[model] WARN: draft download failed (${e.message}); running without it.`);
  }
  console.log("[setup] ready.");
}

main().catch((e) => { console.error("[setup] FATAL:", e.message); process.exit(1); });