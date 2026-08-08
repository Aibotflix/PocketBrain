
## 2026-08-07 — pending: AMD driver update (user updating now, targeting Vulkan iGPU)
After install, verify: & 'C:\Users\steve\AppData\Local\Temp\llama-vulkan\llama-bench.exe' -m 'D:\models\Qwen3.5-4B-Q4_K_M.gguf' -p 398 -n 31 -t 2 (-ngl 99 for GPU test)
If vkQueueSubmit no longer fails -> decide whether to wire win-vulkan-x64 variant for AMD iGPU machines (windows.bat lines ~81-93, add before CPU fallback).
CPU baselines incl. old driver: t2 pp3.52/tg2.00, t4 pp3.89/tg1.25 (t=2 is the live-setting equivalent).
