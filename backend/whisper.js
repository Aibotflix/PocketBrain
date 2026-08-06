// Spawns whisper-server (whisper.cpp STT) as a subprocess and proxies its
// /inference HTTP API. Same pattern as llama.js, kept inside APP_ROOT.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const http = require("http");

const {
  APP_ROOT, BIN_DIR, MODELS_DIR, LOGS_DIR,
  WHISPER_HOST, WHISPER_PORT, STARTUP_TIMEOUT,
} = require("./config");

function findWhisperServer() {
  if (!fs.existsSync(BIN_DIR)) return null;
  const isWin = os.platform() === "win32";
  const exe = isWin ? "whisper-server.exe" : "whisper-server";
  const found = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === exe) found.push(p);
    }
  }
  walk(BIN_DIR);
  return found[0] || null;
}

// STT model: any ggml-*.bin under models/; prefer the configured default.
function findWhisperModel() {
  if (!fs.existsSync(MODELS_DIR)) return null;
  const def = require("./config").WHISPER_MODEL.name;
  const bins = fs.readdirSync(MODELS_DIR)
    .filter((f) => /\.bin$/i.test(f))
    .map((f) => path.join(MODELS_DIR, f));
  if (bins.length === 0) return null;
  const match = bins.find((m) => path.basename(m) === def);
  return match || bins[0];
}

class WhisperServer {
  constructor() { this.proc = null; this.bin = null; this.model = null; }

  async start() {
    if (this.isRunning()) return;
    this.bin = findWhisperServer();
    if (!this.bin) throw new Error("whisper-server binary not found under bin/. Run the launcher.");
    this.model = findWhisperModel();
    if (!this.model) throw new Error("No whisper STT model in models/. Run the launcher (or: node backend/download_stt_model.js).");

    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = path.join(LOGS_DIR, "whisper-server.log");
    const log = fs.createWriteStream(logPath, { flags: "w" });
    const args = [
      "--model", this.model,
      "--host", WHISPER_HOST,
      "--port", String(WHISPER_PORT),
      "--threads", "4",
      "-l", "en",
    ];
    console.log(`[whisper] ${this.bin}\n[whisper]    ${args.join(" ")}`);

    this.proc = spawn(this.bin, args, {
      cwd: path.dirname(this.bin),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    const tee = (chunk, enc) => { const s = chunk.toString(enc); try { log.write(s); } catch (_) {} process.stdout.write(s); };
    this.proc.stdout.on("data", (c) => tee(c));
    this.proc.stderr.on("data", (c) => tee(c));
    this.proc.on("exit", (code, sig) => {
      try { log.end(); } catch (_) {}
      console.log(`[whisper] exited (code=${code} sig=${sig})`);
      this.proc = null;
    });
    this.proc.on("error", (e) => console.error(`[whisper] spawn error: ${e.message}`));

    await waitForReady(WHISPER_HOST, WHISPER_PORT, STARTUP_TIMEOUT);
    console.log(`[whisper] ready at http://${WHISPER_HOST}:${WHISPER_PORT}`);
  }

  async stop() {
    if (!this.proc) return;
    try { this.proc.kill("SIGTERM"); } catch (_) {}
    const t = Date.now();
    while (this.proc && Date.now() - t < 5000) await sleep(200);
    if (this.proc) { try { this.proc.kill("SIGKILL"); } catch (_) {} }
    this.proc = null;
  }

  isRunning() { return !!this.proc; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// whisper-server has no /health; the HTTP listener only starts AFTER the
// model loads, so any response on /inference means fully ready.
function waitForReady(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function probe() {
      const req = http.get(
        { host, port, path: "/inference", timeout: 2000 },
        (res) => {
          res.resume();
          resolve(true); // any HTTP response = model loaded, listener up
        }
      );
      req.on("error", retryOrDie);
      req.on("timeout", () => { req.destroy(); retryOrDie(); });
    }
    function retryOrDie(err) {
      if (Date.now() > deadline) return reject(err || new Error("whisper-server startup timeout"));
      setTimeout(probe, 400);
    }
    probe();
  });
}

module.exports = { WhisperServer, findWhisperServer, findWhisperModel };
