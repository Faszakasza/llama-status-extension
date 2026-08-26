# Proposal: llama-footer-stats

## Why

When pi runs against a local llama.cpp server, the user has no visibility into what the server is doing: how fast tokens are being generated, how far along a long prefill is, how much of the prompt hit the KV cache, and whether speculative decoding is paying off. llama.cpp only prints these numbers to the server's console log. This change adds a pi extension that surfaces a compact, phase-aware stats line in the pi footer.

## What Changes

- New pi extension that, while the active model is served by a llama.cpp `llama-server` provider, renders a one-line status via `ctx.ui.setStatus("llama-stats", …)` (keeps the built-in footer; token usage stats are deliberately out of scope — another extension provides them).
- Stats displayed, all sourced from the server:
  - **tg3s** — token generation speed over a 3s window, shown while generating.
  - **pf3s** — prefill speed over a 3s window, plus a **prefill progress bar** (`processed/total`), shown during the prefill phase.
  - **KV-cache reuse** — `cache/(cache+processed)` hit ratio, shown during prefill.
  - **Spec acceptance** — `1 + Δaccepted/Δdraft_tokens`, shown while generating (server-wide; the counters are server-cumulative).
- Active model + server URL are resolved from `ctx.model` / provider config (provider id form `llama-server=<url>`), refreshed on `model_select`.
- Polling: `/slots?model=<active>` at 500ms while active; `/metrics` (Prometheus text) at ~2s for spec counters. Busiest slot is used when multiple slots are processing. Polling stops (status line cleared) when the active model is no longer a `llama-server` provider.
- Idle state renders a minimal line (model id + `idle`); prefill/generating phases render the relevant stats.

## Capabilities

### New Capabilities

- `llama-stats-footer`: displays phase-aware llama.cpp server statistics (tg3s, pf3s + prefill progress, KV-cache reuse, spec acceptance) in the pi footer while the active model is a llama-server provider.

### Modified Capabilities

(none — `openspec/specs/` is empty; the companion pi-llama-cpp extension is a separate repo and untouched)

## Impact

- **New code**: a single new pi extension (TypeScript, registered in project `.pi`), no new runtime dependencies (native `fetch` only).
- **Server load**: ~2–3 small HTTP GETs per second to the local router while a llama-server model is active; ~0 otherwise.
- **No API/DB changes**; no changes to pi core, pi-llama-cpp, or the llama-server.
- **Dependencies**: reads llama-server endpoints `/slots?model=`, `/metrics`, `/v1/models` — verified against the live router (llama.cpp master-era build, router mode, speculative decoding enabled).
- **Known constraints (accepted)**: `tg3s`/`pf3s` are client-side 3s sliding windows (the server exposes only cumulative counts via HTTP); spec acceptance is server-wide, not per-session; prefill/cache stats reset per request by nature.
