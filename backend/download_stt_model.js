// CLI: node backend/download_stt_model.js
// Downloads the whisper.cpp STT model (ggml-base.en.bin) into models/.
const { download } = require("./download");
const { MODELS_DIR, WHISPER_MODEL } = require("./config");
const path = require("path");
const fs = require("fs");

(async () => {
  const dest = path.join(MODELS_DIR, WHISPER_MODEL.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log("OK cached", WHISPER_MODEL.name);
    process.exit(0);
  }
  try {
    await download(WHISPER_MODEL.url, dest);
    console.log("OK", dest);
    process.exit(0);
  } catch (e) {
    console.error("FAIL", e.message);
    process.exit(1);
  }
})();
