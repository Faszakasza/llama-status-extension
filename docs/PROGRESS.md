# PROGRESS

## Session 2026-08-27 (3)

Implemented change `draft-acceptance-mean-len`: per-turn draft figures from final-chunk timings, persistent draft state with empirical support detection, `/metrics` removed, 500 ms min-span floor for the speed windows.

### Why

- The `draft` field never showed anything (always `-`). Root cause reproduced live: the figure came from 2 s deltas of the Prometheus spec counters (`spec_decode_num_drafts_total` / `spec_decode_num_accepted_tokens_total`), but llama.cpp merges per-slot spec stats into those counters **only when a task completes** (`metrics_on_prediction`) — during a 39 s generating turn with 6 polls every delta was 0. The counters are also server-cumulative, the wrong basis for a per-turn figure.
- The exact data of llama.cpp's own per-task stdout line (`draft acceptance = 0.43033 (349 accepted / 811 generated), mean len = 2.85`) is already on the wire: the tapped stream's final chunk carries per-turn `timings` with `draft_n` / `draft_n_accepted`. A second verified bug: `tg3s` divided a small delta by a millisecond span at turn start (MTP burst, 2–4 tokens within ≤2 ms → 1000 t/s spikes gliding down ~2.5 s).

### Root-cause findings

- `metrics_on_prediction()` merges per-slot spec stats into the Prometheus counters only at task end → the counters are frozen for the whole generating turn (reproduced: 6 polls, all deltas 0).
- `server_slot_stats::to_json()` emits `draft_n` / `draft_n_accepted` in the per-turn `timings` iff the task's spec counter path ran (`n_draft_tokens > 0`); `/slots` never exposes the draft counters at all.
- Ngram-only spec types (`ngram-map-k4v` / `ngram-mod`) leave all counters at 0 and emit no draft fields → empirical detection marks such models `not supported` after their first completed turn; future types that do run the counter path are automatically supported.

### Implementation

- `src/stats.ts`: `TurnTimings` gains nullable `draftN` / `draftNAccepted` (`numOrNull` in `parseChunk` — absent on older builds); new pure draft state machine on `StatsState` (`none` / `value {ratioPct, meanLen}` / `unsupported`) driven by `onTurnEnd(s, timings)` inside `onStreamEnd`: `draftN > 0` → value (ratio = round(accepted/draftN · 100) %, meanLen = 1 + accepted/(predicted_n − accepted), double-rounded through 2 decimals so `2.847 → 2.85 → 2.9x`); stats-less completed turn + `predictedN ≥ 1` + `none` → `unsupported` (never latched, self-heals); value otherwise kept. `RenderView.spec` → `draft` tri-state, rendered `draft -` / `draft not supported` / `draft NN% N.Nx` in every phase. `speed()` gains the 500 ms `MIN_SPAN_MS` floor (→ null → existing `0/s` path). Deleted `SpecCounters` / `specAcceptance` / `updateSpec` / `specPrev` / `specValue`. New `resetTurn()` for stream supersede (windows only); `reset()` keeps clearing the draft (model switch).
- `src/index.ts`: `pollMetrics` + `parseMetric` deleted; the 2 s timer keeps `pollStatus()` only; the stream-end `timings` feed the draft state via the existing `applyEvent` path (superseded stream ends still dropped before `applyEvent`); idle and lifecycle renders carry the draft state; `start()` resets state only when the active model actually changes.
- Tests: `stats.test.ts` spec-delta section rewritten to the state machine + both worked cases (`811/349 → 43% 2.9x`, `48/40/33 → 83% 3.2x`), `accepted=0 → 0% 1.0x`, absent fields, every transition, per-phase rendering, min-span floor (burst ≤100/s for the first 2 s, 3-token 400 ms turn `0/s`, 40-token 2 s window 20 t/s unchanged); `tap.test.ts` end-to-end: figure on the post-turn idle line, persistence through the next turn's prefill/generating lines, second turn update, `not supported` after a fresh model, model-switch reset, abort keeps state, zero `/metrics` + `/slots` over the whole run; `tests/live.ts` asserts a real draft figure and `metrics=0`.

### Verification

- `npm test` green (stats + tap), `npx tsc -p .` strict clean, `openspec validate draft-acceptance-mean-len --strict` valid. (Added `typescript`, `@types/node`, `@earendil-works/pi-coding-agent` as devDeps — `tsc` was not runnable in this environment before.)
- Live (aurora router, MTP model Qwen3.6-35B-A3B): PASS — prefill/generating/idle, real figure on the idle line (e.g. `draft 72% 3.1x`), `metrics=0`, `slots=0`, six fields on every line, non-llama clear. Ngram-only verdict not re-run live (no ngram-only model currently on the router); covered by the unit tests and the empirical-detection design.
- README examples verified byte-for-byte against `renderLine` output via a throwaway script.

### Blockers

- None. Archive ordering: `always-visible-footer-fields` (its 7/7 tasks are done) should be archived before this change — this delta's MODIFIED requirements assume the six-field main spec.

## Session 2026-08-27 (2)

Implemented change `always-visible-footer-fields`: uniform six-field footer line + `separator` setting.

### Why

- The footer swapped whole line layouts per phase (`· idle`, `pf …`, `tg …`), so figures moved position between phases and a non-updating metric was indistinguishable from a zero; the `·` separator was hardcoded, with no escape for narrow terminals or themes where the middle dot renders poorly.

### Implementation

- `src/stats.ts`: `renderLine(model, view, sep = " · ")` — one uniform six-field formatter (model, status, `pf …`, `tg3s …`, `cache …`, `draft …`); `prefill`/`generating` map to status `active`, other phases pass through; non-updating fields render `-` (progress bar stays attached to `pf`, prefill only). `RenderView` unchanged.
- `src/index.ts`: `separator` resolved once per `session_start` — project `<cwd>/.pi/settings.json` (via `CONFIG_DIR_NAME`) only when `ctx.isProjectTrusted()`, else global `<getAgentDir()>/settings.json`, else `" · "`; each file read in try/catch, `.separator` accepted only as a non-empty string; stored module-level and passed into all three `renderLine` call sites.
- Tests: `stats.test.ts` render assertions re-pointed (all six phase lines, dash fields, bar only in prefill) + custom-separator and null `spec`/`cachePct` cases; `tap.test.ts` exact lines updated + one separator case (trusted temp project dir with `.pi/settings.json {"separator": " | "}`; global path made hermetic via `PI_CODING_AGENT_DIR`); `tests/live.ts` now asserts six fields on every rendered line and the non-llama clear.
- `README.md`: example block replaced with the six-field lines (verified byte-for-byte against `renderLine` output via a throwaway script) and the `separator` setting documented (location, precedence, default, lifetime).

### Verification

- `npm test` green (stats + tap), strict tsc clean, `openspec validate --strict` clean (two informational MD041 advisories only).
- Live (aurora router, Chat model Qwen3.6-35B-A3B): one full prefill→generating→idle turn — every footer line uniformly six-field (`sixFields=true`), idle line after the turn, non-llama model select clears the status (`nonLlamaClear=true`), zero `/slots` requests; 33 s turn, `metrics=1 chat=1`.

### Blockers

- None.

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
