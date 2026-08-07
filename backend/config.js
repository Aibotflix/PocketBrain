// All paths resolved relative to the app root, never outside it.
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");

module.exports = {
  APP_ROOT,
  BACKEND_DIR: __dirname,
  BIN_DIR: path.join(APP_ROOT, "bin"),
  MODELS_DIR: path.join(APP_ROOT, "models"),
  RUNTIME_DIR: path.join(APP_ROOT, "runtime"),
  LOGS_DIR: path.join(APP_ROOT, "logs"),
  FRONTEND_DIR: path.join(APP_ROOT, "frontend"),

  // Backend listens here; llama-server on 127.0.0.1:8081, whisper-server on 8082.
  PORT: parseInt(process.env.POCKETBRAIN_PORT, 10) || 3000,
  LLAMA_PORT: parseInt(process.env.POCKETBRAIN_LLAMA_PORT, 10) || 8081,
  LLAMA_HOST: "127.0.0.1",
  WHISPER_PORT: parseInt(process.env.POCKETBRAIN_WHISPER_PORT, 10) || 8082,
  WHISPER_HOST: "127.0.0.1",

  // Pin llama.cpp release. Update tag to bump; asset naming follows
  // llama-b<release>-bin-<os>-<variant>-<arch>.{zip|tar.gz}
  LLAMA_RELEASE: "b10284",

  // Pin whisper.cpp release (STT server). Same naming scheme, separate repo.
  WHISPER_RELEASE: "v1.9.2",

  // STT model: whisper base.en (English-only, ~148 MB). Swap to
  // ggml-small.en.bin (465 MB, better accuracy) for more headroom.
  WHISPER_MODEL: {
    name: "ggml-base.en.bin",
    repo: "ggerganov/whisper.cpp",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    sizeHint: 148_000_000,
  },

  // Default model. Current 2026 release line: 4B is the default - a real
  // step up in answer accuracy (translations, facts) over the 2B it replaced.
  // Q4_K_M keeps it small enough for a 4GB stick alongside draft + voice.
  DEFAULT_MODEL: {
    name: "Qwen3.5-4B-Q4_K_M.gguf",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    sizeHint: 2_740_000_000,
  },

  // Speculative-decoding draft (~533 MB). Same family + tokenizer as the
  // main models (rule #1 for drafts) - llama-server auto-uses it when the
  // file is present: ~1.3-1.5x faster answers, zero quality loss.
  DRAFT_MODEL: {
    name: "Qwen3.5-0.8B-Q4_K_M.gguf",
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf",
    sizeHint: 533_000_000,
  },

  // llama-server startup timeout (ms). Model load can take a while.
  STARTUP_TIMEOUT: 180_000,
  SHUTDOWN_TIMEOUT: 5_000,
};
