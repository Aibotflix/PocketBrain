// Web search for chat context. Single provider, keyless, no signup:
// Firecrawl /v2/search — the original fast path (~1.4-2.8s). Returns the
// search engine's own title+description, which carries real factual text.
//
// API (keyless, 1k credits/mo): POST api.firecrawl.dev/v2/search
//   { query, limit } -> j.data.web[].{title,url,description}
//
// Cache: 5-min in-process LRU keyed by query+limit. Repeats are ~0ms.
//
// No silent timeout-to-stale: if every call fails, search() rejects and
// the chat handler runs the model with NO grounding message. The model's
// own directive tells it to admit it has no current info in that case
// (server.js DIRECTIVE) — honest, not stale.

const FIRECRAWL = "https://api.firecrawl.dev/v2/search";
const TIMEOUT_MS = 8_000;
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// ponytail: Map preserves insertion order; delete + re-set = LRU in ~3 lines.
// Cap 200 entries. Upgrade to a real LRU lib only if memory shows up.
function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  if (v.ts + CACHE_TTL < Date.now()) return undefined;
  cache.delete(key); cache.set(key, v); // move to MRU
  return v.value;
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { ts: Date.now(), value });
}

async function searchFirecrawl(q, limit) {
  const res = await withTimeout(fetch(FIRECRAWL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, limit }),
  }), TIMEOUT_MS);
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const j = await res.json();
  const web = j.data && (j.data.web || j.data);
  return (Array.isArray(web) ? web : []).slice(0, limit).map((r) => ({
    title: r.title || r.url || "result",
    url: r.url || "",
    snippet: String(r.description || r.snippet || "").slice(0, 300),
  }));
}

async function search(q, limit = 3) {
  const query = String(q || "").trim();
  if (!query) return { provider: "none", results: [], note: "empty query" };

  const ck = `${query}::${limit}`;
  const cached = cacheGet(ck);
  if (cached) return Object.assign({}, cached, { cached: true });

  const results = await searchFirecrawl(query, limit);
  if (!results.length) throw new Error("no results from any provider");

  const out = { provider: "firecrawl", results };
  cacheSet(ck, out);
  return out;
}

module.exports = { search };

if (require.main === module) {
  const q = process.argv[2] || "who is the president of the philippines";
  const s = Date.now();
  search(q, 3).then((r) => {
    console.log(`[${Date.now() - s}ms] provider: ${r.provider}${r.cached ? " (cached)" : ""}, ${r.results.length} results`);
    for (const h of r.results) console.log(`- ${h.title}\n  ${h.snippet.slice(0, 160)}\n  ${h.url}`);
  }).catch((e) => { console.error("ERR", e.message); process.exit(1); });
}