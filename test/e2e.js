// E2E smoke test: assumes backend already running on port 3000.
const http = require("http");

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: 3000, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    r.on("error", reject);
    r.setTimeout(200000, () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  console.log("[1] /health ...");
  let h = await req("GET", "/health");
  console.log("   ->", h.status, h.text);

  console.log("[2] POST /api/start ...");
  let s = await req("POST", "/api/start?ngl=0");
  console.log("   ->", s.status, s.text.slice(0, 200));

  console.log("[3] poll /api/models until llama up ...");
  let up = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const m = await req("GET", "/api/models");
      const j = JSON.parse(m.text);
      if (j.llama) { up = true; console.log("   llama up after", i * 0.5, "s  models=", j.models.join(",")); break; }
    } catch (_) {}
  }
  if (!up) return console.log("   FAIL: llama never came up");

  console.log("[4] GET / (frontend) ...");
  let f = await req("GET", "/");
  console.log("   -> status", f.status, "bytes", f.text.length, "pocketbrain?=", f.text.includes("PocketBrain"));

  console.log("[5] POST /api/chat stream ...");
  const payload = JSON.stringify({
    messages: [
      { role: "system", content: "/no_think You are concise. Reply in one short sentence." },
      { role: "user", content: "Say hello and what 2+2 equals." },
    ],
    stream: true,
    max_tokens: 512,
  });
  let c = await req("POST", "/api/chat", payload, { "Content-Type": "application/json" });
  let acc = "", think = "";
  for (const line of c.text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try {
      const o = JSON.parse(p);
      const d = o.choices?.[0]?.delta || {};
      if (d.reasoning_content) think += d.reasoning_content;
      if (d.content) acc += d.content;
    } catch (_) {}
  }
  console.log("   status", c.status);
  console.log("   REASONING:", JSON.stringify(think.slice(0, 120)));
  console.log("   REPLY:", JSON.stringify(acc.slice(0, 160)));

  console.log("[6] POST /v1/chat/completions (OpenAI passthrough, no stream) ...");
  const payload2 = JSON.stringify({
    messages: [
      { role: "system", content: "You are concise. Reply in one short sentence." },
      { role: "user", content: "Say hello and what 2+2 equals." },
    ],
    stream: false,
    max_tokens: 80,
  });
  let p2 = await req("POST", "/v1/chat/completions", payload2, { "Content-Type": "application/json" });
  console.log("   status", p2.status, "->", p2.text.slice(0, 160));

  console.log("[7] whisper STT: /api/voice/status + transcribe ...");
  let vs = await req("GET", "/api/voice/status");
  console.log("   status ->", vs.status, vs.text);
  // Generate a 1s 8kHz WAV on the fly so the test has no missing fixture.
  const wav = Buffer.alloc(44 + 8000, 0);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + 8000, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36);
  wav.writeUInt32LE(8000, 40);
  let t = await req("POST", "/api/voice/transcribe", wav, { "Content-Type": "audio/wav" });
  console.log("   transcribe ->", t.status, t.text.slice(0, 200));

  console.log("[8] web search: POST /api/search ...");
  let s8 = await req("POST", "/api/search", JSON.stringify({ q: "quantum computing" }), { "Content-Type": "application/json" });
  console.log("   search ->", s8.status, JSON.stringify(s8.text).slice(0, 240));
}

main().catch((e) => { console.error("E2E FAIL:", e.message); process.exit(1); });