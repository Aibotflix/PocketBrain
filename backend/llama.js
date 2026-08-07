// Spawns llama-server as a subprocess, waits for it to be ready, proxies
// OpenAI/llama-server HTTP API. Keeps everything inside APP_ROOT.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const http = require("http");

const {
  APP_ROOT, BIN_DIR, MODELS_DIR, LOGS_DIR,
  LLAMA_HOST, LLAMA_PORT, STARTUP_TIMEOUT,
} = require("./config");

// Every llama-server binary present under bin/, deepest paths first
// (e.g. bin/win-cpu-x64/llama-server.exe). Sorted so the DIRECT (linux/mac,
// unzipped-root) binary wins over a nested variant dir.
function findAllServers() {
  const found = [];
  if (!fs.existsSync(BIN_DIR)) return found;
  const isWin = os.platform() === "win32";
  const exe = isWin ? "llama-server.exe" : "llama-server";
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === exe) found.push(p);
    }
  }
  walk(BIN_DIR);
  // GPU variants first (faster), CPU last as automatic fallback. Within a
  // tier, prefer the more specific (shallow) install.
  const gpuScore = (p) => {
    const d = path.basename(path.dirname(p)).toLowerCase();
    if (/cuda/.test(d)) return 0;
    if (/hip|rocm/.test(d)) return 1;
    if (/vulkan/.test(d)) return 2;
    if (/opencl/.test(d)) return 3;
    if (/metal/.test(d)) return 0;
    return 6; // cpu / generic -> furthest back
  };
  return found.sort((a, b) => {
    const ga = gpuScore(a), gb = gpuScore(b);
    if (ga !== gb) return ga - gb;
    return a.length - b.length; // shallowest first within tier
  });
}

function findLlamaServer() { return findAllServers()[0] || null; }

function listModels() {
  if (!fs.existsSync(MODELS_DIR)) return [];
  // The draft model is never selectable as the main model.
  const draft = require("./config").DRAFT_MODEL.name;
  return fs.readdirSync(MODELS_DIR)
    .filter((f) => /\.gguf$/i.test(f) && f !== draft)
    .map((f) => path.join(MODELS_DIR, f));
}

function pickModel(cliArg) {
  if (cliArg) {
    const p = path.isAbsolute(cliArg) ? cliArg : path.join(MODELS_DIR, path.basename(cliArg));
    if (fs.existsSync(p)) return p;
  }
  const models = listModels();
  if (models.length === 0) {
    throw new Error(
      "No model found in models/. Run the launcher (or: node backend/download_model.js) first."
    );
  }
  const def = require("./config").DEFAULT_MODEL.name;
  const match = models.find((m) => path.basename(m) === def);
  return match || models[0];
}

function get(v) { return v !== undefined ? String(v) : null; }

// Build the argv. llama-server flags: --model, --host, --port, --ctx-size,
// --cont-batching, -ngl, --alias, --load-mode (mlock on Windows: USB FAT
// page-faults are brutal; mlock keeps the model in RAM, no mmap).
function buildArgs(bin, model, opts = {}) {
  const isWin = os.platform() === "win32";
  const a = [
    "--model", model,
    "--host", LLAMA_HOST,
    "--port", String(LLAMA_PORT),
    "--alias", "pocketbrain",
    "--ctx-size", String(opts.ctx || 8192),
    "--cont-batching",
    "--parallel", "1",
    "--temp", String(opts.temp || 0.7),
    "--top-p", String(opts.topP || 0.9),
    "--reasoning", "off", // qwen3.5 defaults to on; off = direct answers, faster
  ];
  if (get(opts.ngl) !== null) a.push("-ngl", String(opts.ngl));
  // Windows + USB: default is mmap, which page-faults to death on FAT/exFAT.
  // "none" = read the model fully into RAM, no mmap, no VirtualLock attempt
  // (VirtualLock on Windows regularly fails -> scary warning, and the lock is
  // best-effort anyway: it never worked, so nothing is lost).
  if (isWin) a.push("--load-mode", "none");
  // Speculative decoding: if the draft GGUF is present, hand it to
  // llama-server. Same-family/tokenizer model -> ~1.3-1.5x faster tokens.
  // Cross-family drafts are auto-rejected by llama.cpp itself (WARN only).
  const draft = path.join(require("./config").MODELS_DIR, require("./config").DRAFT_MODEL.name);
  if (fs.existsSync(draft)) a.push("--model-draft", draft);
  return a;
}

class LlamaServer {
  constructor() { this.proc = null; this.bin = null; this.model = null; this.ready = false; }

  // Try each available llama-server binary in preference order. Prefer the
  // one with mostly GPU-free CPU argv first? No: caller supplies a preferred
  // order via opts.candidates (already GPU-first). We fall through on failure.
  async start({ model, ngl, candidates, onTry } = {}) {
    if (this.isRunning()) return;
    this.model = pickModel(model);
    const pool = candidates && candidates.length
      ? candidates.map((b) => path.resolve(b))
      : findAllServers();
    if (pool.length === 0) throw new Error("llama-server binary not found under bin/. Run the launcher.");

    let lastErr = null;
    for (const bin of pool) {
      this.bin = bin;
      try {
        if (onTry) onTry(bin);
        await this.spawnOne(bin);
        return;
      } catch (e) {
        lastErr = e;
        console.log(`[llama] ${path.basename(path.dirname(bin))} failed: ${e.message}`);
        await this.stop(); // ensure cleanup
      }
    }
    throw new Error(`All llama-server candidates failed. Last: ${lastErr && lastErr.message}`);
  }

  async spawnOne(bin) {
    const runtimeDir = path.dirname(bin);
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = path.join(LOGS_DIR, "llama-server.log");
    const log = fs.createWriteStream(logPath, { flags: "w" });

    const args = buildArgs(bin, this.model, { ngl: this.ngl || 0 });
    console.log(`[llama] ${bin}\n[llama]    ${args.join(" ")}`);

    this.proc = spawn(bin, args, {
      cwd: runtimeDir, // keep any sidecar DLLs in scope
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    // Tee child stdio to the log file + our console.
    const tee = (chunk, enc) => { const s = chunk.toString(enc); try { log.write(s); } catch (_) {} process.stdout.write(s); };
    this.proc.stdout.on("data", (c) => tee(c));
    this.proc.stderr.on("data", (c) => tee(c));
    this.proc.on("exit", (code, sig) => {
      try { log.end(); } catch (_) {}
      console.log(`[llama] exited (code=${code} sig=${sig})`);
      this.proc = null;
      this.ready = false;
    });
    this.proc.on("error", (e) => {
      console.error(`[llama] spawn error: ${e.message}`);
    });

    await waitForReady(LLAMA_HOST, LLAMA_PORT, STARTUP_TIMEOUT);
    this.ready = true;
    console.log(`[llama] ready at http://${LLAMA_HOST}:${LLAMA_PORT}`);
  }

  async stop() {
    this.ready = false;
    if (!this.proc) return;
    try { this.proc.kill("SIGTERM"); } catch (_) {}
    const t = Date.now();
    while (this.proc && Date.now() - t < 5000) await sleep(200);
    if (this.proc) { try { this.proc.kill("SIGKILL"); } catch (_) {} }
    this.proc = null;
  }

  isRunning() { return this.ready && !!this.proc; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll /health until 200 or timeout. llama-server exposes /health.
function waitForReady(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function probe() {
      const req = http.get(
        { host, port, path: "/health", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve(true);
          retryOrDie();
        }
      );
      req.on("error", retryOrDie);
      req.on("timeout", () => { req.destroy(); retryOrDie(); });
    }
    function retryOrDie(err) {
      if (Date.now() > deadline) return reject(err || new Error("llama-server startup timeout"));
      setTimeout(probe, 400);
    }
    probe();
  });
}

module.exports = { LlamaServer, findAllServers, findLlamaServer, listModels, pickModel };