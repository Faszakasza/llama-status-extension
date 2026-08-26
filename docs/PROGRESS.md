# PROGRESS

## Session 2026-08-26

Built the llama-stats footer extension (change `llama-footer-stats`) from scratch.

### Exploration

- Confirmed the harness is pi; extension API = `ctx.ui.setStatus` + `pi.on` events; project-local extensions live in `.pi/extensions/<dir>/index.ts` (auto-discovered, `/reload`-able).
- Investigated the live router (`aurora.home.lan:10000`, router mode, speculative decoding on) and the llama.cpp master source to map which stats are actually exposed over HTTP.
- Key findings:
  - `tg3s`/`pf3s` are NOT in any HTTP endpoint — only cumulative per-task counters on `/slots` and Prometheus counters on `/metrics`. So the extension computes 3 s sliding windows client-side from polls (same technique as the llama.cpp Web UI).
  - Router mode requires `?model=<id>`; active model = `ctx.model`, provider id `llama-server=<url>`.
  - Spec counters are server-cumulative; ngram-only spec decode (Qwen3.6) never increments them — only draft-model/MTP (Qwen3.8) does.
  - The router unloads idle models; `/slots` for a non-loaded model returns 500. → status-first gating.

### Implementation

- `stats.ts` (pure) + `stats.test.ts` (assert via jiti) + `index.ts` (wiring). No new dependencies.
- Status-first polling: `/v1/models` (2 s) gates `/slots` (500 ms) + `/metrics` (2 s).

### Verification

- Unit: `stats.test.ts` all checks pass (run through jiti — this node build lacks `--experimental-strip-types`).
- `tsc --noEmit` clean (strict) against the real pi types.
- Live (Chat model, so the Coder context cache is never evicted): full lifecycle `· unloaded → · loading → prefill (pf+bar+cache) → generating (tg+spec) → · idle → clear on non-llama`. Confirmed `/slots` 500s while unloaded.
- Live (Coder model): tg 37–53 t/s tracking, idle transitions, clear on model switch.

### Blockers

- None. (Initial live checks evicted the Coder model's KV cache because the router is single-request; fixed by running load-generating checks against the Chat model.)
