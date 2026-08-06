// Backend HTTP server. Serves the frontend and proxies chat -> llama-server.
// Two modes: OpenAI-compatible passthrough (/v1/...) and a simple /api/chat
// convenience that maps OpenAI-style messages and returns SSE tokens.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { APP_ROOT, FRONTEND_DIR, LOGS_DIR, LLAMA_HOST, LLAMA_PORT, WHISPER_HOST, WHISPER_PORT } = require("./config");
// Where the write_file tool saves generated files (HTML, code, etc).
const OUTPUT_DIR = path.join(APP_ROOT, "outputs");
const { LlamaServer, listModels } = require("./llama");
const { WhisperServer, findWhisperServer, findWhisperModel } = require("./whisper");
const { downloadModel } = require("./download");
const { search } = require("./search");

// Set by main() once the signal handlers are wired; used by POST /api/stop.
let shutdownApp = null;

// llama-server runs with --ctx-size 8192; a long chat + injected web results
// can exceed that and the request gets cancelled with an error. Keep the
// prompt + answer under ctx by trimming oldest history. Reserved answer budget
// 1024 tokens (--ctx 8192) so prompt budget is ~6144. Never drop system/grounding
// messages or the newest user message. chars/4 is a rough token estimate.
const CTX_BUDGET = 6144;
const estTokens = (s) => Math.ceil((s || "").length / 4) + 8;
function fitMessages(msgs) {
  const keep = (m, i) => m.role === "system" || i === msgs.length - 1;
  let total = msgs.reduce((n, m) => n + estTokens(m.content), 0);
  let i = 0;
  while (total > CTX_BUDGET && i < msgs.length - 1) {
    if (!keep(msgs[i], i)) {
      total -= estTokens(msgs[i].content);
      msgs.splice(i, 1);
    } else {
      i++;
    }
  }
  return msgs;
}

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

  // In-page Stop: stops llama/whisper but keeps the backend alive, so the
  // user can click Start again. To fully quit, close the console window
  // (or Ctrl+C) — shutdown() there stops children then exits.
  if (req.method === "POST" && p === "/api/stop") {
    return Promise.all([llama.stop(), whisper.stop()])
      .then(() => sendJSON(res, 200, { ok: true, stopped: true }))
      .catch((e) => sendJSON(res, 500, { error: { message: e.message } }));
  }

  if (req.method === "POST" && p === "/api/start") {
    if (llama.isRunning()) return sendJSON(res, 200, { ok: true, already: true });
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

  // Files written by the write_file tool (e.g. a generated HTML file).
  // Served from APP_ROOT/outputs only, so the tool can't be abused to
  // read/write elsewhere on the machine.
  if (req.method === "GET" && p === "/api/file") {
    const name = path.basename(parsed.searchParams.get("name") || "");
    if (!name) return sendJSON(res, 400, { error: { message: "missing name" } });
    const file = path.join(OUTPUT_DIR, name);
    if (!file.startsWith(OUTPUT_DIR)) return sendJSON(res, 403, { error: { message: "forbidden" } });
    return fs.readFile(file, (err, data) => {
      if (err) return sendJSON(res, 404, { error: { message: "not found" } });
      const ext = path.extname(file).toLowerCase();
      return send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` });
    });
  }

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
      const body = JSON.parse(chunks.length ? Buffer.concat(chunks).toString() : "{}");
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
      const lines = r.results.map((x, i) => {
        const sn = (x.snippet || "").replace(/\s+/g, " ").trim().slice(0, 300);
        return `${i + 1}. ${x.title} — ${sn}\n   ${x.url}`;
      }).join("\n");
      return { role: "system", content: `Web search results (${r.provider}):\n${lines}\n\nGround your answer in these. If they don't answer the question, say so.` };
    };

    // Terse output directive: on slow local hardware (CPU ~5 t/s) every
    // output token is wall-clock time, and shorter answers free context
    // for web results. This is the "caveman" style trick for chat.
    const DIRECTIVE = "Be brief. Keep all facts.";

    // ---- Tool calling (the model proposes, the backend executes) ----------
    // Only write_file is exposed: saves generated files (HTML, code) into
    // APP_ROOT/outputs. Kept to a single tool because a 2B model loses
    // coherence past one; unknown names get an error back so it can retry.
    const TOOLS = [{
      type: "function",
      function: {
        name: "write_file",
        description: "Save generated content (HTML page, code, text) to a file the user can open. Use when the user asks to create or save a file.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string", description: "File name including extension, e.g. page.html" },
            content: { type: "string", description: "Full file content" },
          },
          required: ["filename", "content"],
        },
      },
    }];

    const MAX_TOOL_ROUNDS = 3;

    // Non-streaming round-trip to llama-server; returns the parsed JSON.
    const llamaChat = (effective, tools) => new Promise((resolve, reject) => {
      const upBody = JSON.stringify({
        messages: effective,
        temperature: body.temperature ?? 0.7,
        top_p: body.top_p ?? 0.9,
        max_tokens: body.max_tokens ?? 1024,
        stream: false,
        ...(tools ? { tools } : {}),
      });
      const out = [];
      const upstream = http.request({
        host: LLAMA_HOST, port: LLAMA_PORT, path: "/v1/chat/completions", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(upBody) },
        timeout: 120_000,
      }, (up) => {
        up.on("data", (b) => out.push(b));
        up.on("end", () => {
          try { resolve({ status: up.statusCode || 502, json: JSON.parse(Buffer.concat(out).toString()) }); }
          catch (e) { reject(new Error("llama bad response: " + e.message)); }
        });
        up.on("error", reject);
      });
      upstream.on("error", reject);
      upstream.write(upBody);
      upstream.end();
    });

    // Execute one tool call; never throw. Guards: basename-only filename,
    // size cap, unknown tool name -> error string the model can recover from.
    const execTool = async (call) => {
      const fn = call && call.function && call.function.name;
      if (fn !== "write_file") return JSON.stringify({ error: `Unknown tool "${fn}". Available tools: write_file` });
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) { return JSON.stringify({ error: "Bad arguments JSON" }); }
      const name = path.basename(String(args.filename || "").trim());
      if (!name || name.includes("\\")) return JSON.stringify({ error: "filename must be a plain name like page.html" });
      const content = String(args.content || "");
      // The content is echoed back into context for the model's final answer,
      // so cap it to fit the 8K window (~6K tokens); bigger files get a hint
      // to split. The file itself is always saved in full.
      if (content.length > 24_000) return JSON.stringify({ error: "content too large — max 24000 chars per file, split into multiple files" });
      try {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUTPUT_DIR, name), content, "utf8");
        return JSON.stringify({ ok: true, url: `/api/file?name=${encodeURIComponent(name)}` });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    };

    // Tool loop: run until the model answers without tool calls, max 3 rounds.
    const runWithTools = async (effective) => {
      for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
        const r = await llamaChat(effective, TOOLS);
        const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
        if (!msg) return r;
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) return r;
        effective.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
        for (const call of calls) {
          const result = await execTool(call);
          effective.push({
            role: "tool",
            tool_call_id: (call && call.id) || "call_0",
            name: (call.function || {}).name || "unknown",
            content: result,
          });
        }
      }
      return { status: 200, json: { error: "tool loop exceeded rounds" } };
    };

    // llama.cpp's template allows only ONE leading system message — merge the
    // directive, any incoming leading system message, and the web-results
    // grounding into a single system message instead of stacking them.
    const run = async (sysMsg) => {
      const base = messages[0] && messages[0].role === "system" ? messages[0] : null;
      const rest = base ? messages.slice(1) : messages;
      const parts = [DIRECTIVE, base && base.content, sysMsg && sysMsg.content].filter(Boolean);
      const effective = fitMessages([{ role: "system", content: parts.join("\n\n") }, ...rest]);

      // Tool mode: run the (non-streaming) tool loop, then relay the final
      // answer as SSE so the frontend render path stays identical.
      if (body.tools) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
        });
        try {
          const r = await runWithTools(effective);
          const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
          const text = (msg && msg.content) || "";
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          if (r.status !== 200) res.write(`data: ${JSON.stringify({ error: r.json && r.json.error })}\n\n`);
        } catch (e) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

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
      // Run search but still forward the request even if it fails; offline
      // or no results just means the model answers from its own knowledge.
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
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" || err.code === "EACCES") {
      // Another Stick AI instance (or a stale one from a previous session) is
      // already on this port. If it's ours, just open the browser - no error.
      // If it's some other program, say so clearly instead of dying silently.
      const probe = http.get({ host: "127.0.0.1", port, path: "/" }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          if (body.includes("Stick AI")) {
            console.log(`[stickai] already running on port ${port} - opening browser`);
            openBrowser(`http://127.0.0.1:${port}`);
            process.exit(0);
          } else {
            console.error(`[stickai] ERROR: port ${port} is in use by another program.`);
            console.error(`[stickai] Close that program (or the stale window) and re-run.`);
            process.exit(1);
          }
        });
      });
      probe.on("error", () => {
        console.error(`[stickai] ERROR: port ${port} is in use. Close the stale window and re-run.`);
        process.exit(1);
      });
    } else {
      console.error("[stickai] server error:", err);
      process.exit(1);
    }
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
