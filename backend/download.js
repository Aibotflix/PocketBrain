// Download helper. All downloads land inside APP_ROOT. Resumable, with size
// validation when the server returns Content-Length. No external deps.
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const { APP_ROOT, MODELS_DIR, LOGS_DIR } = require("./config");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function head(method, url) {
  return ["-->", method, url].join(" ");
}

// Progress callback(statusStr). Writes to stdout line.
function download(url, dest, opts = {}) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const tmp = dest + ".part";
    // A stale .part means a previous download died halfway. Never resume a
    // half-trusted file, never leave .part behind: restart from byte 0. If
    // this new attempt fails, the cleanup below deletes it again - the .part
    // exists only for the lifetime of an in-flight download.
    const cleanup = (p) => { try { fs.unlinkSync(p); } catch (_) {} };
    cleanup(tmp);
    const start = 0;

    const headers = Object.assign({ "User-Agent": "pocketbrain/0.1" }, opts.headers || {});

    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers, timeout: 30_000 }, (res) => {
      // Handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, opts));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        cleanup(tmp);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const totalHeader = parseInt(res.headers["content-length"] || "0", 10);
      const total = totalHeader ? totalHeader + start : 0;
      const out = fs.createWriteStream(tmp, { flags: start > 0 ? "a" : "w" });
      let received = start;
      let lastReport = 0;

      res.on("data", (chunk) => {
        received += chunk.length;
        if (total && received - lastReport > total / 50) {
          const pct = ((received / total) * 100).toFixed(1);
          process.stdout.write(
            `\r  ${path.basename(dest)}  ${pct}% (${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`
          );
          lastReport = received;
        }
      });

      res.pipe(out);
      out.on("finish", () => {
        out.close((err) => {
          if (err) { cleanup(tmp); return reject(err); }
          if (total && Math.abs(received - total) > 1024 * 16) {
            cleanup(tmp);
            return reject(new Error(`Size mismatch: got ${received}, expected ${total}`));
          }
          fs.renameSync(tmp, dest);
          // Always land on a final 100% line instead of the last ~2% tick
          // being swallowed by the progress-throttle check above.
          if (total) process.stdout.write(`\r  ${path.basename(dest)}  100% (${(total / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)\n`);
          resolve(dest);
        });
      });
      out.on("error", (e) => { cleanup(tmp); reject(e); });
    });
    req.on("error", (e) => { cleanup(tmp); reject(e); });
    req.on("timeout", () => { cleanup(tmp); req.destroy(new Error("download timeout")); });
  });
}

async function downloadModel(model = null) {
  const cfg = require("./config");
  const m = typeof model === "string" ? cfg[model] : (model || cfg.DEFAULT_MODEL);
  const dest = path.join(MODELS_DIR, m.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`[model] cached: ${m.name}`);
    return dest;
  }
  console.log(`[model] downloading ${m.name}`);
  await download(m.url, dest);
  console.log(`[model] saved -> ${path.relative(APP_ROOT, dest)}`);
  return dest;
}

module.exports = { download, downloadModel, ensureDir };
