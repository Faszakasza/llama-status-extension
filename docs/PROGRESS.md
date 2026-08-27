# PROGRESS

## Session 2026-08-27

Implemented change `sse-tap-stats`: replaced the 500 ms `/slots` polling with an in-process tap on the active model's `/chat/completions` SSE stream.

### Why

- The old version hit the router ~3 req/s during a turn (`/slots` @ 2 Hz + `/v1/models` + `/metrics`) and kept polling `/metrics` while the model was merely loaded; every displayed speed was a 2 Hz sample of cumulative counters, so the 3 s windows carried fetch-latency skew.
- Live probe (aurora router) showed llama.cpp pushes exact per-turn data inside the stream pi already consumes: `prompt_progress` (`{total, cache, processed, time_ms}` at ~1.4 Hz) when the request sets `return_progress: true`, and a final `usage` + server `timings` chunk when `stream_options.include_usage: true`. The router passes both through unmodified.

### Implementation

- `src/index.ts`: `globalThis.fetch` wrapper — intercepts only `/chat/completions` to the current target's base URL, injects `return_progress` + `stream_options.include_usage` into string bodies with `stream: true` (non-string/unparseable body passes through unmutated; the tap then degrades to the lifecycle line), wraps the response in a pass-through `ReadableStream` re-emitting the original bytes unchanged. Deleted `pollSlots`/`parseSlot`/`slotsInFlight`. Restored on `session_shutdown` / non-llama switch.
- `src/stats.ts`: `observe()`/`SlotView`/`pickSlot`/counter-drop turn detection replaced by `onProgress`/`onToken`/`onStreamEnd` + pure `parseChunk` + latest-wins `StreamTracker` (new unseen `chatcmpl-…` id supersedes, late events dropped, superseded close is a no-op). Token = non-empty `delta.content` **or** `delta.reasoning_content` (thinking models). `onStreamEnd` records the final `timings` as the turn's last pf sample on the total basis (`prompt_n + cache_n`). Windows/cache/spec/rendering unchanged.
- Re-gating: `/metrics` only while a tapped stream is generating; `/v1/models` @ 2 s lifecycle render suppressed while a stream is active; status-poll failure without a stream → `· offline`; stream abort/error → idle, not offline.
- Baseline committed first (`fix: idle phase in observe()...`); `npm test` + strict tsc green after each step.

### Verification

- Unit: `stats.test.ts` (re-pointed to stream events) + `tap.test.ts` (pass-through bytes, target-only injection, phase sequencing, offline/abort, fetch restore) — `npm test` green via jiti; strict tsc clean.
- Live (aurora, Chat model Qwen3.6-35B-A3B, so the Coder cache is never evicted): full turn prefill bar + cache % tracking `prompt_progress`, tg tracking generation, turn end → idle, spec figure when counters advanced; zero `/slots` requests (request log); active turn ≈1.0 req/s, loaded-idle ≈0.5 req/s.
- Cross-check (task 5.3): the window's final pf vs the same turn's `timings.prompt_per_second` within a few percent, for one captured turn.
- Edge cases: concurrent subagent turn (latest-wins visible), mid-turn model switch (reset + tap re-targets), `unloaded → loading → idle` lifecycle, non-llama model (status cleared).

### Blockers

- None. `pi-llama-cpp-stats` stays installed in this environment; the two `fetch` patches chain and its working-message bar is now a redundant subset (documented, not uninstalled — user's call).
### Archive (same day)

- Synced the delta into the main spec `openspec/specs/llama-stats-footer/spec.md` (1 added: Concurrent stream handling; 7 modified around the tap; 1 removed: Busiest slot selection). `openspec validate --specs` passes.
- Moved the change to `openspec/changes/archive/2026-08-27-sse-tap-stats/`. No active openspec changes remain; no code touched by the archive.

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

### Packaging (restructure, same day)

- User: the `.pi/extensions/llama-stats/` layout is wrong for distribution — pointed at `gsanhueza/pi-llama-cpp` as the reference. That repo is a publishable pi package: root `package.json` with a `pi` manifest (`pi.extensions`), source in `src/`, tests in `tests/`.
- Restructured to match: `git mv` → `src/{index,stats}.ts` + `tests/stats.test.ts`; added `package.json` (pi manifest + `pi-package` keyword, jiti devDep, `npm test`), `tsconfig.json` (mirrors the reference; `allowImportingTsExtensions` for the `.ts` import specifiers), `README.md` (install/usage/dev).
- Local wiring: `pi install -l --approve .` registers the repo root as a project package (`..` in `.pi/settings.json`, gitignored) — the project now consumes its own package the same way any user would; `pi config -l` shows `.. → [x] src/index.ts`.
- `node --experimental-strip-types` does not work in this sandbox's node build (`ERR_NO_TYPESCRIPT`, not compiled with TS support) — tests run through jiti (`npm test`).
- Verified: `npm test` passes, strict tsc clean against real pi types (via a throwaway /tmp tsconfig with a `paths` override — the committed tsconfig mirrors the reference, which relies on pi injecting its own modules into `node_modules` at install time), `openspec validate` still valid.
- Pushed to `Faszakasza/llama-status-extension`. No extension code changed.
