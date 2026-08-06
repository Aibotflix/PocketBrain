// CLI: node backend/download_model.js [url] [name]
// Downloads the default model (or an override) into models/.
const { downloadModel } = require("./download");
const { DEFAULT_MODEL } = require("./config");

(async () => {
  const model = process.argv[2]
    ? { ...DEFAULT_MODEL, url: process.argv[2], name: process.argv[3] || DEFAULT_MODEL.name }
    : DEFAULT_MODEL;
  try {
    const dest = await downloadModel(model);
    console.log("OK", dest);
    process.exit(0);
  } catch (e) {
    console.error("FAIL", e.message);
    process.exit(1);
  }
})();
