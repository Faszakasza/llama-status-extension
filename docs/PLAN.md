# PLAN — llama-status-extension

## Goal

A pi extension that displays live statistics about the active llama.cpp model in the pi footer.

## Stats (final scope)

| Stat | Source | Phase shown |
| --- | --- | --- |
| tg3s — generation speed, 3 s sliding window | `/slots?model=<id>` deltas | generating |
| pf3s — prefill speed, 3 s sliding window + progress bar | `/slots` deltas | prefill |
| KV-cache reuse — `cache/(cache+processed)` | `/slots` | prefill |
| spec acceptance — `1 + Δaccepted/Δdraft-steps` | `/metrics` (Prometheus) | generating, only when the server reports draft activity |

Deliberately excluded: session token-usage/cost (another extension owns it), per-request `timings` (SSE-only), RAM/VRAM (not exposed).

## Design

- **Where**: publishable pi package at the repo root (same layout as `gsanhueza/pi-llama-cpp`):
  - `package.json` — pi manifest: `pi.extensions: ["./src/index.ts"]`, `pi-package` keyword; installed via `pi install git:github.com/Faszakasza/llama-status-extension`.
  - `src/index.ts` — pi wiring: active-model resolution, poll loops, status line.
  - `src/stats.ts` — pure logic (window math, turn detection, slot picking, spec acceptance, rendering). Zero pi imports.
  - `tests/stats.test.ts` — assert-based checks, `npm test` (jiti dev-only runner; this node build lacks `--experimental-strip-types`).
  - Local dev: `pi install -l --approve .` registers the repo root as a project package (`.pi/settings.json`, gitignored).
- **Active model**: `ctx.model` + `model_select`; provider id form `llama-server=<baseUrl>` (fallback: `ctx.modelRegistry.getProvider(id).baseUrl`).
- **Rendering**: `ctx.ui.setStatus("llama-stats", line)` — coexists with the built-in footer and other extensions.
- **Polling**: `/v1/models` status 2 s **gates** everything — `/slots` 500 ms + `/metrics` 2 s only run while `status == loaded` (the router returns 500 from `/slots` for a non-loaded model, and unloads idle models). In-flight guard on `/slots`; fetch timeouts 2 s/3 s.
- **Lifecycle rendering**: non-loaded statuses render `· loading` / `· unloaded` (or the raw word for `failed`/`sleeping`); a failed status fetch renders `· offline`. Avoids a misleading `offline` during model load and avoids hammering `/slots` for an unloaded model.
- **Turn state machine** (only one in the codebase): new turn ⇔ `n_prompt_tokens_processed` dropped OR `n_decoded` reset to 0. Window + cache reset on turn start.
- **Offline**: a status or slots fetch failure ⇒ clear windows, render `· offline`, auto-recover next poll. `/slots` stays ~4 ms under load, so no false offline while busy.
- **Busiest slot**: generating beats prefill; tie-break on tokens in flight (active model runs `parallel=1`; guard only).

### Verified endpoint field map (router mode, live)

| Field | Meaning |
| --- | --- |
| `slots[i].is_processing` | slot busy |
| `slots[i].next_token[0].n_decoded` | generated tokens this turn |
| `slots[i].n_prompt_tokens` | prompt total (grows during generation) |
| `slots[i].n_prompt_tokens_processed` | prompt tokens processed |
| `slots[i].n_prompt_tokens_cache` | prompt tokens from KV cache |
| `llamacpp:spec_decode_num_drafts_total` / `..._accepted_tokens_total` | server-cumulative spec counters |

## Status

- [x] Proposal / specs / design / tasks (openspec change `llama-footer-stats`)
- [x] Pure stats core + tests
- [x] Extension wiring (model resolution, polling, status line)
- [x] Live verification against the aurora router (Coder Qwen3.8-27B: tg 37–53 t/s, idle transitions, clear on non-llama; Chat Qwen3.6-35B-A3B: full prefill→generating→idle cycle, spec 7.0x when counters advanced)
- [x] Model-lifecycle gating: `/v1/models` status poll gates slot/metrics polling; verified live Chat model `· unloaded → · loading → prefill → idle` and that `/slots` returns 500 for a non-loaded model
- [x] Docs + validate + commit (this file)
- [x] Packaged as a pi package (repo-root `package.json` + `src/` layout, matching `pi-llama-cpp`); `pi config -l` shows `.. → [x] src/index.ts`

## Known limitations

- `tg3s`/`pf3s` are client-side windows (server exposes no per-window figures over HTTP).
- Spec acceptance is server-wide (cumulative counters) and only appears for models with draft-model/MTP spec decoding — ngram-only spec decode never increments the Prometheus counters (verified: Qwen3.6 stays 0 mid-generation; figure is then correctly hidden).
- No API-key support (ponytail comment in `index.ts`); add `readStoredCredential(model.provider)` if a keyed server appears.
