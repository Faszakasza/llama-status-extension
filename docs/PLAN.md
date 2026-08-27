# PLAN — llama-status-extension

## Goal

A pi extension that displays live statistics about the active llama.cpp model in the pi footer.

## Stats (final scope)

| Stat | Source | Phase shown |
| --- | --- | --- |
| tg3s — generation speed, 3 s sliding window | tapped stream: token-arrival timestamps (`content` + `reasoning_content` deltas) | generating |
| pf3s — prefill speed, 3 s sliding window + progress bar | tapped stream: `prompt_progress` events (server `time_ms`) | prefill |
| KV-cache reuse — `cache/(cache+processed)` | tapped stream: live `cache` field on `prompt_progress` | prefill |
| spec acceptance — `1 + Δaccepted/Δdraft-steps` | `/metrics` (Prometheus), polled only while a turn is generating | generating, only when the server reports draft activity |
| turn's final speeds | final SSE chunk's server `timings`, recorded as the turn's last window sample (cross-check, not a separate display) | end of turn |

Deliberately excluded: session token-usage/cost (another extension owns it), any new display figure derived from `timings` (cross-check only), RAM/VRAM (not exposed).

## Design

- **Where**: publishable pi package at the repo root (same layout as `gsanhueza/pi-llama-cpp`):
  - `package.json` — pi manifest: `pi.extensions: ["./src/index.ts"]`, `pi-package` keyword; installed via `pi install git:github.com/Faszakasza/llama-status-extension`.
  - `src/index.ts` — pi wiring: active-model resolution, fetch tap, lifecycle/metrics polls, status line.
  - `src/stats.ts` — pure logic (window math, SSE chunk parsing, latest-wins stream tracking, spec acceptance, rendering). Zero pi imports.
  - `tests/stats.test.ts` + `tests/tap.test.ts` — assert-based checks, `npm test` (jiti dev-only runner; this node build lacks `--experimental-strip-types`). `tests/live.ts` is a manual live run against the router.
  - Local dev: `pi install -l --approve .` registers the repo root as a project package (`.pi/settings.json`, gitignored).
- **Active model**: `ctx.model` + `model_select`; provider id form `llama-server=<baseUrl>` (fallback: `ctx.modelRegistry.getProvider(id).baseUrl`).
- **Rendering**: `ctx.ui.setStatus("llama-stats", line)` — coexists with the built-in footer and other extensions.
- **SSE tap** (`src/index.ts`): a `globalThis.fetch` wrapper intercepts `/chat/completions` requests to the current target's base URL only; injects `return_progress: true` + `stream_options.include_usage: true` into string JSON bodies with `stream: true` (non-string or unparseable bodies pass through unmutated — the tap then degrades to status-line-only, never crashes); wraps the response in a pass-through `ReadableStream` that re-emits the original bytes unchanged and parses `data:` lines for stats. Patches chain with other extensions (e.g. pi-llama-cpp-stats) and are restored on `session_shutdown` / non-llama switch.
- **Turn boundary**: stream open (first chunk with an unseen `chatcmpl-…` id) opens a turn; stream end (`[DONE]`, usage chunk, close, cancel, or error) ends it. Concurrency is latest-wins: a new stream supersedes the active one, late events from superseded streams are dropped, and closing a superseded stream does not idle the newest one.
- **Polling (lifecycle + spec only)**: `/v1/models` @ 2 s renders lifecycle states between turns (`· loading` / `· unloaded`, raw word for `failed`/`sleeping`); its render is suppressed while a stream is active, and a failed poll renders `· offline` only when no stream is active (a stream abort is a turn end → idle, not offline). `/metrics` @ 2 s runs only while a tapped stream is in the generating phase (spec counters). Fetch timeouts 3 s.
- **Windows**: one `speed()` over `{t, v}` samples, 3 s, partial while history is shorter; pf samples carry server `time_ms`, tg samples carry wall-clock arrival time. `onStreamEnd` records the final chunk's `timings` as the turn's last pf sample (total basis: `prompt_n + cache_n`, since `prompt_n` excludes cached tokens) so the window's final figure cross-checks against `timings.prompt_per_second` (`LLAMA_STATS_DEBUG` logs both).
- **Coexistence**: with pi-llama-cpp-stats installed, both `fetch` patches chain (each wraps the previous); both inject the same body flags idempotently; its working-message prefill bar becomes a redundant subset of this footer.

### Verified stream field map (router mode, live)

| Field | Meaning |
| --- | --- |
| chunk `id` | `chatcmpl-…` request id on every chunk — stream correlation |
| `prompt_progress` | `{total, cache, processed, time_ms}` — server-timed prefill progress, ~1.4 Hz |
| final chunk `usage` | token counts (incl. `prompt_tokens_details.cached_tokens`) |
| final chunk `timings` | `{prompt_n, cache_n, prompt_ms, prompt_per_second, predicted_n, predicted_ms, predicted_per_second}` — server-computed per-turn figures |
| `llamacpp:spec_decode_num_drafts_total` / `..._accepted_tokens_total` | server-cumulative spec counters (`/metrics`, still polled while generating) |

(`/slots` is no longer polled at all; the fields it used to supply are superseded by the stream above.)

## Status

- [x] Proposal / specs / design / tasks (openspec change `llama-footer-stats`)
- [x] Pure stats core + tests
- [x] Extension wiring (model resolution, polling, status line)
- [x] Live verification against the aurora router (Coder Qwen3.8-27B: tg 37–53 t/s, idle transitions, clear on non-llama; Chat Qwen3.6-35B-A3B: full prefill→generating→idle cycle, spec 7.0x when counters advanced)
- [x] Model-lifecycle gating: `/v1/models` status poll gates slot/metrics polling; verified live Chat model `· unloaded → · loading → prefill → idle` and that `/slots` returns 500 for a non-loaded model
- [x] Docs + validate + commit (this file)
- [x] Packaged as a pi package (repo-root `package.json` + `src/` layout, matching `pi-llama-cpp`); `pi config -l` shows `.. → [x] src/index.ts`
- [x] SSE tap (openspec change `sse-tap-stats`): in-turn stats from the tapped `/chat/completions` stream; `/slots` polling deleted; `/metrics` gated on stream-generating; latest-wins stream tracking; final `timings` recorded as the turn's last sample; live-verified on aurora (full turn on the Chat model, spec figure when counters advanced, subagent concurrency, mid-turn model switch, lifecycle, non-llama clear, zero `/slots` requests)

## Known limitations

- Speeds are client-side windows (server exposes no per-window figures); the window's final sample is seeded from the final chunk's server `timings`, so it cross-checks against `timings.prompt_per_second`/`predicted_per_second` (`LLAMA_STATS_DEBUG` logs the pf comparison).
- Spec acceptance is server-wide (cumulative counters) and only appears for models with draft-model/MTP spec decoding — ngram-only spec decode never increments the Prometheus counters (verified: Qwen3.6 stays 0 mid-generation; figure is then correctly hidden).
- The tap targets the string JSON body pi sends to `/chat/completions` today; a non-string body skips the flag injection and the extension degrades to the lifecycle line (no crash).
- No API-key support (ponytail comment in `index.ts`); add `readStoredCredential(model.provider)` if a keyed server appears.
