// CLI: node backend/download_model.js [url] [name]
// Downloads the default model (or an override) into models/.
// Config keys (DEFAULT_MODEL, DRAFT_MODEL, WHISPER_MODEL) are accepted as a
// bare first arg, e.g.: node backend/download_model.js DRAFT_MODEL
const { downloadModel } = require("./download");
const cfg = require("./config");

(async () => {
  const arg = process.argv[2];
  let model;
  if (!arg) model = cfg.DEFAULT_MODEL;
  else if (cfg[arg]) model = cfg[arg]; // bare config key, e.g. DRAFT_MODEL
  else model = { ...cfg.DEFAULT_MODEL, url: arg, name: process.argv[3] || cfg.DEFAULT_MODEL.name };
  try {
    const dest = await downloadModel(model);
    console.log("OK", dest);
    process.exit(0);
  } catch (e) {
    console.error("FAIL", e.message);
    process.exit(1);
  }
})();
