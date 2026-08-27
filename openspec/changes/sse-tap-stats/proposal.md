## Why

The extension currently hammers the router with ~3 req/s during an active turn (`/slots` @ 2 Hz + `/v1/models` + `/metrics`) and keeps polling `/metrics` even when the model is loaded but idle — and every displayed speed is a 2 Hz sample of cumulative counters, so the 3 s windows carry fetch-latency skew. llama.cpp already pushes exact per-turn data (`prompt_progress` with total/processed/cache/time_ms, per-token deltas, final `usage`+`timings`) inside the SSE stream pi is already consuming. Tapping that stream in-process gives server-timed stats at ~zero extra request load. Live-verified against the aurora router: the router passes `prompt_progress` and `timings` through unmodified.

## What Changes

- **ADDED** In-process fetch tap on the active model's `/chat/completions` SSE response: injects `return_progress` and `stream_options.include_usage` into the request, parses `prompt_progress` events, per-token deltas, and the final `usage`/`timings` chunk, and re-emits the response bytes unchanged so the agent's stream is untouched.
- **REMOVED** The 500 ms `/slots` polling loop and everything derived from it: slot parsing, busiest-slot selection, and counter-drop turn detection. Stream open/close becomes the turn boundary.
- **MODIFIED** `pf3s`, prefill bar, and cache % are sourced from `prompt_progress` events (live `cache` field) instead of `/slots` deltas.
- **MODIFIED** `tg3s` is sourced from token-arrival timestamps; the final chunk's server `timings` are recorded as the turn's last (authoritative) sample and serve as the live cross-check.
- **MODIFIED** `/metrics` (spec acceptance) polling is gated on a tapped stream being in generation instead of on the model merely being loaded — no metrics polling for a loaded-idle model.
- **ADDED** Per-request tracking with latest-stream-wins, so concurrent subagent turns and mid-turn model switches cannot cross-contaminate the displayed stats.
- **KEPT** `/v1/models` status poll @ 2 s for lifecycle display (loading/unloaded/offline) between turns; footer rendering format; model-switch stat reset; spec acceptance display.

## Capabilities

### New Capabilities

(None — all behavior lives in the existing `llama-stats-footer` capability.)

### Modified Capabilities

- `llama-stats-footer`: data source for all in-turn phase displays changes from slot polling to the SSE stream tap; the busiest-slot requirement is removed (no slots to pick); the 3 s window sourcing changes from poll samples to stream events; `/metrics` gating moves from model-loaded to stream-generating; lifecycle rendering applies only when no stream is active.

## Impact

- `src/index.ts`: replace `pollSlots`/`parseSlot` with the fetch wrapper + stream parsing; re-gate `pollMetrics`; keep `pollStatus` (2 s). Net smaller file.
- `src/stats.ts`: `observe(state, now, slots)` re-pointed to stream-event inputs (`onProgress`, `onToken`, `onStreamEnd`); `SlotView`/`pickSlot`/turn-detection dropped; windows, `cachePct`, `updateSpec`, `renderLine` survive nearly intact.
- `tests/stats.test.ts`: simpler inputs (plain event objects); window/render assertions kept; pass-through check added.
- Runtime: patches `globalThis.fetch` (chains with other patches, restored on `session_shutdown`); no new dependencies.
- Router load: active turn ~3.0 → ~1.0 req/s; loaded-idle 1.0 → 0.5 req/s; unloaded unchanged (0.5).
- `pi-llama-cpp-stats` (if installed): patches chain safely; its working-message prefill bar becomes a redundant subset of this footer.
