# CHANGES

## 2026-08-26 — llama-stats footer extension (change `llama-footer-stats`)

- Added `.pi/extensions/llama-stats/` — a pi extension that renders live llama.cpp stats in the footer while the active model is a `llama-server` provider.
- Stats: tg3s (gen speed, 3 s window), pf3s + prefill progress bar, KV-cache reuse, spec acceptance.
- `stats.ts` = pure logic (window math, turn detection, slot pick, spec acceptance, rendering); `index.ts` = pi wiring; `stats.test.ts` = assert checks (run via jiti).
- Status-first polling: `/v1/models` (2 s) gates `/slots` (500 ms) + `/metrics` (2 s). Non-loaded model → `· loading` / `· unloaded`; fetch failure → `· offline`. Avoids the misleading `offline` that `/slots` 500s produce during model load/unload.
- Live-verified against the aurora router on both the Coder (Qwen3.8-27B) and Chat (Qwen3.6-35B-A3B) models.
- Initialized git; `.gitignore` now tracks `.pi/extensions/` (the extension source) while ignoring the rest of `.pi/`.
