# Design: llama-footer-stats

## Context

See proposal.md for motivation. Constraints that shape the approach, all verified against the live router (`aurora.home.lan:10000`, llama.cpp master-era build, router mode, speculative decoding on) and llama.cpp master source:

- **`tg3s`/`pf3s` do not exist in any HTTP endpoint.** `/slots` exposes cumulative per-task counters only; the 3s-window figures live solely in the server's console log. The extension must compute them client-side from consecutive samples (as the llama.cpp Web UI does).
- **Router mode requires the model name**: root `/slots` returns 400 without `?model=<id>`; the active model id is what the router loads/unloads.
- **The active model is `ctx.model`** (event `model_select` keeps it current). The provider id is `llama-server=<baseUrl>` — the same convention pi-llama-cpp uses (`PROVIDER_PREFIX = "llama-server"`). `ctx.modelRegistry.getProvider(id).baseUrl` is the resolution path.
- **Token usage is already covered** by another extension, so this extension touches no session/usage data.

Verified endpoint field map (router mode):

| Stat | Endpoint | Field |
| --- | --- | --- |
| slot busy? | `GET /slots?model=<id>` | `slots[i].is_processing` |
| generated tokens | `GET /slots?model=<id>` | `slots[i].next_token[0].n_decoded` |
| prompt total | `GET /slots?model=<id>` | `slots[i].n_prompt_tokens` (grows during generation: prompt+generated) |
| prompt processed | `GET /slots?model=<id>` | `slots[i].n_prompt_tokens_processed` |
| prompt cached | `GET /slots?model=<id>` | `slots[i].n_prompt_tokens_cache` |
| spec counters | `GET /metrics?model=<id>` | `llamacpp:spec_decode_num_draft_tokens_total`, `llamacpp:spec_decode_num_accepted_tokens_total` (server-cumulative, Prometheus text) |

## Goals / Non-Goals

**Goals:**

- One status line via `ctx.ui.setStatus("llama-stats", …)`; coexists with the built-in footer and other extensions' statuses.
- Phase-aware rendering: idle / prefill / generating / offline.
- Correct stats per model switch, with zero state leak between models.
- Bounded server load: `/slots` at 500 ms, `/metrics` at 2 s, only while a llama-server model is active.

**Non-Goals:**

- No session token-usage/cost stats (another extension owns that).
- No per-request `timings` (they live in the SSE stream pi consumes; extensions can't tap it).
- No RAM/VRAM (not exposed by `/v1/models` or `/slots`).
- No config surface — sensible fixed defaults; a settings command can come later if ever wanted.

## Decisions

**D1 — Poll `/slots` + `/metrics` over HTTP instead of intercepting the SSE stream.**
The server does not expose 3s-window speeds anywhere on the wire; only cumulative counters. Client-side windowing from polls is the same technique the official Web UI uses. Alternative rejected: parsing the server console log — wrong host, fragile, and pi runs against a LAN box.

**D2 — `ctx.ui.setStatus` instead of `ctx.ui.setFooter`.**
`setStatus` appends to the built-in footer (which other extensions also use, e.g. token usage); `setFooter` replaces the whole footer and would clobber them. Alternative rejected.

**D3 — Subdirectory layout: `index.ts` + pure `stats.ts`, no new dependencies.**
The extension lives in `.pi/extensions/llama-stats/` (pi's project-local subdirectory discovery loads only `index.ts`): `index.ts` = pi wiring (provider/model resolution, polling, status line), `stats.ts` = pure logic (window math, turn detection, slot picking, spec acceptance, line rendering, zero pi imports) so it is testable, `stats.test.ts` = one assert-based check file run via `node --experimental-strip-types` (Node 22, no framework). Native `fetch` + `setInterval`, no npm dependencies.

**D4 — Window math: sample ring buffer, not EMA.**
Keep the last 3 s of `{t, n_decoded, n_prompt_processed}` samples (ring, cap ~20). Speed = (count_now − count_at_oldest_sample_within_3s) / elapsed. Partial window allowed (spec). Reset buffer on model change and when a new turn starts (turn start = slot transitions idle→processing, detected by `n_prompt_tokens_processed` dropping / `n_decoded` resetting to 0). This gives the "first 3 seconds" partial-window behavior for free.

**D5 — Turn detection.**
`n_decoded` resets to 0 and `n_prompt_tokens_processed` drops between turns. New turn ⇔ (processed < lastSeenProcessed) OR (decoded == 0 AND lastSeenDecoded > 0). Cache ratio and window reset on turn start. This is the only state machine in the extension; everything else is derive-and-render.

**D6 — Spec acceptance from `/metrics` deltas, 2 s cadence.**
`1 + Δaccepted/Δdraft_tokens` over the metrics interval, recomputed each metrics poll; shown only while generating and Δdraft > 0. Server-cumulative ⇒ stable number, fine for a footer. Alternative rejected: per-slot draft counters — the server exposes them only in final responses/SSE, not on `/slots` or `/metrics`.

**D7 — Busiest slot.**
Filter `is_processing`; prefer `n_decoded > 0`; tie-break on `n_prompt_tokens_processed + n_decoded`. Active model runs `parallel=1`, so this is mostly a correctness guard.

**D8 — Status-first gating.** The router loads models on demand and unloads them after inactivity; `/slots` for a non-loaded model returns 500 (verified live), and idle-unload means the active model can be `unloaded` while pi sits idle. So the extension polls `/v1/models` (2 s) first and only polls `/slots` (500 ms) + `/metrics` (2 s) while `status == loaded`. Non-loaded statuses render `· loading` / `· unloaded` (or the raw word for `failed`/`sleeping`); a failed status fetch renders `· offline`. This avoids a misleading `offline` during load and avoids hammering `/slots` for a model that isn't there.

**D9 — Offline rendering.** A status or slots fetch failure (network error / non-2xx) ⇒ clear the window buffer and render `<model> · offline` (no stale numbers). Recovery resumes normal rendering on the next success. No retry backoff: poll cadence is already 500 ms.

**D10 — Render format** (single line, dim theme):

- unloaded: `Qwen3.8-27B · unloaded`
- loading: `Qwen3.8-27B · loading`
- idle: `Qwen3.8-27B · idle`
- prefill: `Qwen3.8-27B · pf 1.8k/s ▓▓░░░░ 34% cache 97%`
- generating: `Qwen3.8-27B · tg 78/s spec 1.9x`
- offline: `Qwen3.8-27B · offline`

Bar: 6 chars (`▓`/`░`). Number formatting: `>=1000` → `1.2k`. Spec figure only while generating (D6).

## Risks / Trade-offs

- [Server build differences: `/slots` fields could differ on older builds] → guard every field access with `?? 0` / `.get()`; worst case a stat shows nothing, never crashes. Router-mode `?model=` query is the documented contract in llama.cpp master; single-model mode (no router) also accepts `?model=` (ignored or accepted) — verify at task time against a plain `llama-server` if one is available; otherwise document router-mode as the supported target.
- [500 ms polling on a busy LAN box] → two tiny GETs/s, same order as pi-llama-cpp's own polling; negligible.
- [Prefill bar granularity: `n_prompt_tokens_processed` updates in ubatches] → bar may jump in chunks; acceptable at 6 chars.
- [Spec counters are server-wide, so two parallel sessions share the number] → accepted (proposal/Impact); it answers "is spec decode earning its keep".
- [pi-llama-cpp extension also polls the same server] → independent, read-only endpoints; no interaction.

## Migration Plan

Deploy: drop the extension file in the project `.pi` extensions location; pi loads extensions at startup (reload or restart picks it up). Rollback: delete the file; the status line disappears with `setStatus` cleanup on dispose. No data, no schema, no service changes.

## Open Questions

Resolved: project-local auto-discovery (with `/reload` hot-reload support) is `.pi/extensions/` — the extension lives at `.pi/extensions/llama-stats/index.ts`. No settings entry needed.
