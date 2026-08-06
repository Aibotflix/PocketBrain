// Backend HTTP server. Serves the frontend and proxies chat -> llama-server.
// Two modes: OpenAI-compatible passthrough (/v1/...) and a simple /api/chat
// convenience that maps OpenAI-style messages and returns SSE tokens.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { APP_ROOT, FRONTEND_DIR, LOGS_DIR, LLAMA_HOST, LLAMA_PORT, WHISPER_HOST, WHISPER_PORT } = require("./config");
const { LlamaServer, listModels } = require("./llama");
const { WhisperServer, findWhisperServer, findWhisperModel } = require("./whisper");
const { downloadModel } = require("./download");
const { search } = require("./search");

// Set by main() once the signal handlers are wired; used by POST /api/stop.
let shutdownApp = null;

const llama = new LlamaServer();
const whisper = new WhisperServer();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ "Cache-Control": "no-store" }, headers));
  res.end(body);
}
function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

// Tail of llama-server.log (last ~60 lines) so the UI can explain failures.
function getLogTail() {
  const logPath = path.join(LOGS_DIR, "llama-server.log");
  try {
    const text = fs.readFileSync(logPath, "utf8");
    return text.split("\n").filter(Boolean).slice(-60);
  } catch {
    return [];
  }
}

// Open the app URL in the default browser. Best-effort: on Windows also
// detach so the child survives; every failure is swallowed (headless SSH,
// no GUI, etc). Skipped when AIUSB_NO_OPEN=1.
function openBrowser(url) {
  if (process.env.AIUSB_NO_OPEN === "1") return;
  const { exec } = require("child_process");
  const plat = process.platform;
  try {
    if (plat === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
      child.unref();
    } else if (plat === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (_) {}
}

// Forward a request body to llama-server and pipe response back. Used for
// OpenAI-compatible endpoints so any future client (the llama.cpp frontend,
// third-party tools) just works without us re-implementing chat completions.
function proxyToLlama(req, res, targetPath, method = req.method, transformBody = null) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? Buffer.concat(chunks) : null;
    let payload = body;
    if (transformBody && body) {
      try { payload = Buffer.from(transformBody(body)); } catch (e) {
        return sendJSON(res, 400, { error: { message: e.message } });
      }
    }
    const upstream = http.request({
      host: LLAMA_HOST, port: LLAMA_PORT, path: targetPath, method,
      headers: sanitizeHeaders(req.headers, payload ? payload.length : 0),
      timeout: 120_000,
    }, (up) => {
      res.writeHead(up.statusCode || 502, Object.assign({}, up.headers, { "connection": "keep-alive" }));
      up.pipe(res);
    });
    upstream.on("error", (e) => sendJSON(res, 502, { error: { message: `upstream: ${e.message}` } }));
    upstream.on("timeout", () => { upstream.destroy(); sendJSON(res, 504, { error: { message: "upstream timeout" } }); });
    if (payload) upstream.write(payload);
    upstream.end();
  });
}

// Copy client headers to upstream, dropping hop-by-hop/conflicting ones.
// We always set content-length ourselves (we buffered the body), so any
// transfer-encoding/chunked from the client must go away.
function sanitizeHeaders(headers, contentLength) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (["host", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection", "upgrade"].includes(lk)) continue;
    out[k] = v;
  }
  out["host"] = `${LLAMA_HOST}:${LLAMA_PORT}`;
  out["content-length"] = String(contentLength);
  return out;
}

async function serveStatic(req, res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  const file = path.join(FRONTEND_DIR, p);
  if (!file.startsWith(FRONTEND_DIR)) return sendJSON(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJSON(res, 404, { error: "not found" });
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream" });
  });
}

async function handle(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = parsed.pathname;

  if (req.method === "GET" && p === "/health") return sendJSON(res, 200, { ok: true, llama: llama.isRunning() });
  if (req.method === "GET" && p === "/api/models") {
    return sendJSON(res, 200, { models: listModels().map((m) => path.basename(m)), llama: llama.isRunning() });
  }
  // Tail of llama-server.log (last ~60 lines) so the UI can explain failures.
  if (req.method === "GET" && p === "/api/logs") {
    return sendJSON(res, 200, { lines: getLogTail() });
  }
  // STT availability: binary + model present on this platform. macOS has no
  // prebuilt whisper.cpp release, so the UI hides the mic there.
  if (req.method === "GET" && p === "/api/voice/status") {
    return sendJSON(res, 200, {
      available: !!findWhisperServer() && !!findWhisperModel(),
      running: whisper.isRunning(),
      platform: process.platform,
    });
  }
  // STT: raw WAV bytes in the body -> whisper-server /inference -> { text }.
  if (req.method === "POST" && p === "/api/voice/transcribe") {
    return handleTranscribe(req, res);
  }
  // Web search -> { provider, results:[{title,url,snippet}] }. Firecrawl
  // Keyless — real web search, no API key, no signup (see backend/search.js).
  if (req.method === "POST" && p === "/api/search") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(chunks.length ? Buffer.concat(chunks).toString() : "{}");
        const r = await search(body.q || "", 5);
        return sendJSON(res, 200, r);
      } catch (e) {
        return sendJSON(res, 502, { error: { message: e.message } });
      }
    });
    return;
  }
  if (req.method === "GET" && p === "/api/download-model") {
    try {
      const m = await downloadModel();
      return sendJSON(res, 200, { ok: true, model: path.basename(m) });
    } catch (e) {
      return sendJSON(res, 500, { error: { message: e.message } });
    }
  }

  // In-page Stop: same code path as Ctrl+C — stops llama/whisper, then exits.
  // Reply first, then exit on a short timer so the browser sees "stopped".
  if (req.method === "POST" && p === "/api/stop") {
    sendJSON(res, 200, { ok: true });
    setTimeout(() => (shutdownApp || (async () => process.exit(0)))(), 200);
    return;
  }

  if (req.method === "POST" && p === "/api/start") {    if (llama.isRunning()) return sendJSON(res, 200, { ok: true, already: true });
    const used = [];
    try {
      await llama.start({
        model: parsed.searchParams.get("model"),
        ngl: parseInt(parsed.searchParams.get("ngl") || "0", 10),
        onTry: (bin) => {
          used.push(path.basename(path.dirname(bin)));
          console.log(`[stickai] trying ${bin}`);
        },
      });
      return sendJSON(res, 200, { ok: true, tried: used, bin: path.basename(path.dirname(llama.bin)) });
    } catch (e) {
      return sendJSON(res, 500, {
        error: { message: e.message, tried: used, log: getLogTail() },
      });
    }
  }

  // OpenAI-compatible passthrough to llama-server's own /v1/* endpoints.
  if (p.startsWith("/v1/")) {
    return proxyToLlama(req, res, p, req.method);
  }

  // Simple convenience chat (non-streaming + streaming) for our frontend.
  // streaming defaults to SSE; false returns JSON.
  if (req.method === "POST" && p === "/api/chat") return handleChat(req, res);

  if (req.method === "GET") return serveStatic(req, res, p);
  return sendJSON(res, 404, { error: "not found" });
}

// Receive raw WAV bytes, start whisper-server, forward as multipart to its
// /inference endpoint, return { text }. Uses a random boundary each time.
function handleTranscribe(req, res) {
  const chunks = [];
  // whisper-server needs a model loaded before serving; auto-start like llama.
  const ensure = async () => {
    await whisper.start();
    const body = Buffer.concat(chunks);
    const boundary = "----stickai" + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    );
    const tail = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`
    );
    const payload = Buffer.concat([head, body, tail]);
    const upstream = http.request({
      host: WHISPER_HOST, port: WHISPER_PORT, path: "/inference?response_format=json", method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length,
      },
      timeout: 120_000,
    }, (up) => {
      const resp = [];
      up.on("data", (c) => resp.push(c));
      up.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(resp).toString());
          return sendJSON(res, 200, { text: (j.text || "").trim(), duration: j.duration });
        } catch (e) {
          return sendJSON(res, 502, { error: { message: "whisper: bad response: " + e.message } });
        }
      });
      up.on("error", (e) => sendJSON(res, 502, { error: { message: "whisper: " + e.message } }));
    });
    upstream.on("error", (e) => sendJSON(res, 502, { error: { message: "whisper: " + e.message } }));
    upstream.write(payload);
    upstream.end();
  };
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!chunks.length) return sendJSON(res, 400, { error: { message: "empty audio body" } });
    ensure().catch((e) => sendJSON(res, 500, { error: { message: "whisper: " + e.message } }));
  });
}

function handleChat(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      var body = JSON.parse(chunks.length ? Buffer.concat(chunks).toString() : "{}");
    } catch (e) {
      return sendJSON(res, 400, { error: { message: "bad json: " + e.message } });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const stream = body.stream !== false;

    // web search mode: add a system message with fresh results before the
    // conversation so the model can ground its answer. Best-effort.
    const injectWeb = async () => {
      const last = [...messages].reverse().find((m) => m && m.role === "user");
      if (!last) return null;
      const r = await search(last.content, 5).catch(() => ({ provider: "none", results: [] }));
      if (!r.results.length) return null;
      const lines = r.results.map((x, i) => `${i + 1}. ${x.title} — ${x.snippet}\n   ${x.url}`).join("\n");
      return { role: "system", content: `Web search results (${r.provider}):\n${lines}\n\nGround your answer in these. If they don't answer the question, say so.` };
    };

    const run = async (sysMsg) => {
      const effective = sysMsg ? [sysMsg, ...messages] : messages;
      const upstreamBody = JSON.stringify({
        messages: effective,
        temperature: body.temperature ?? 0.7,
        top_p: body.top_p ?? 0.9,
        max_tokens: body.max_tokens ?? 1024,
        stream,
      });

      if (!stream) {
        // Stream the JSON to llama and relay the full body back once done.
        const out = [];
        const upstream = http.request({
          host: LLAMA_HOST, port: LLAMA_PORT, path: "/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(upstreamBody) },
          timeout: 120_000,
        }, (up) => {
          up.on("data", (b) => out.push(b));
          up.on("end", () => {
            const text = Buffer.concat(out).toString();
            try {
              return sendJSON(res, up.statusCode || 502, JSON.parse(text));
            } catch (_) {
              return send(res, up.statusCode || 502, text, { "Content-Type": "application/json; charset=utf-8" });
            }
          });
          up.on("error", (e) => sendJSON(res, 502, { error: { message: `upstream: ${e.message}` } }));
        });
        upstream.on("error", (e) => sendJSON(res, 502, { error: { message: `upstream: ${e.message}` } }));
        upstream.write(upstreamBody);
        upstream.end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
      });
      const upstream = http.request({
        host: LLAMA_HOST, port: LLAMA_PORT, path: "/v1/chat/completions", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(upstreamBody) },
        timeout: 120_000,
      }, (up) => {
        up.on("data", (b) => res.write(b)); // passthrough SSE chunks
        up.on("end", () => res.end());
        up.on("error", () => { try { res.end(); } catch (_) {} });
      });
      upstream.on("error", () => { try { res.end(); } catch (_) {} });
      upstream.write(upstreamBody);
      upstream.end();
    };

    if (body.web) {
      // Run search but still forward the request even if it fails; the search
      // helper itself degrades to Wikipedia, so a failure means offline.
      injectWeb().then(run).catch((e) => { console.error("web search:", e && e.message); run(null); });
    } else {
      run(null);
    }
  });
}

async function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const port = require("./config").PORT;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("handler error:", e);
      try { sendJSON(res, 500, { error: { message: e.message } }); } catch (_) {}
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[stickai] backend on http://127.0.0.1:${port}`);
    console.log(`[stickai] open http://127.0.0.1:${port} in your browser`);
    openBrowser(`http://127.0.0.1:${port}`);
  });

  // Best-effort heal: stop llama/whisper, then exit. Shared by Ctrl+C and the
  // in-page Stop button so killing one way never orphans the .exe children.
  async function shutdown() {
    await Promise.all([llama.stop(), whisper.stop()]);
    process.exit(0);
  }
  shutdownApp = shutdown;
  ["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, shutdown));
  return { shutdown };
}

module.exports = { main };
main();
