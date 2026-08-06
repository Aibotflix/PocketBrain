// Web search for chat context. Single provider, no fallbacks.
//
// Researched August 2026 — everything else is dead:
//   - DDG scraping (duck-duck-scrape, ddg-kit): BOT_CHALLENGE after 1 query,
//     60s cooldown. Dead for chat.
//   - Bing HTML: 200 but serves junk/region-cached pages to bots (Bing's
//     search API retired Aug 2025, HTML page is now bot-hostile).
//   - Google News RSS: keyless and reliable but NEWS ONLY — not web search.
//   - SearXNG public instances: JSON disabled + anti-bot.
//   - Firecrawl Keyless (June 2026): real web search, no API key, no signup,
//     1,000 free credits/month. Verified 3/3 on trap questions
//     (Carney / Marcos Jr / Spain won 2026 WC). THE provider.

const ENDPOINT = "https://api.firecrawl.dev/v2/search";

async function search(q, limit = 5) {
  const query = String(q || "").trim();
  if (!query) return { provider: "none", results: [], note: "empty query" };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const web = j.data && (j.data.web || j.data);
  const results = (Array.isArray(web) ? web : []).slice(0, limit).map((r) => ({
    title: r.title || r.url || "result",
    url: r.url || "",
    snippet: String(r.description || r.snippet || "").slice(0, 400),
  }));
  if (!results.length) throw new Error("no results");
  return { provider: "firecrawl", results };
}

module.exports = { search };

if (require.main === module) {
  search(process.argv[2] || "who is the president of the philippines", 5).then((r) => {
    console.log(`provider: ${r.provider}, ${r.results.length} results`);
    for (const h of r.results) console.log(`- ${h.title}\n  ${h.snippet.slice(0, 160)}`);
  }).catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
