# CHANGES

## 2026-08-27 — Fix: empty footer on resumed/new/forked sessions

- Root cause: `src/index.ts` applied the active model only on `session_start` with `reason === "startup"`. Pi emits `session_start` with `reason: "resume"` (session resume/switch), `"new"` (`/new`), `"fork"`, or `"reload"`, and on those paths the model is restored at runtime construction **without** a `model_select` event (`model_select` fires only on user-driven `setModel`/`cycleModel`). So in any non-fresh-startup session the extension never targeted the router: no tap, no lifecycle poll, no status line — while unrelated extensions (pi-lens, ponytail) kept rendering in the powerline footer, which made it look like a powerline conflict (it was not: powerline's `extension_statuses` segment renders whatever `ui.setStatus` keys exist).
- Fix (one line): `session_start` now calls `applyModel(ctx)` for every reason (it is idempotent — `start()` re-runs `stop()` first; `resolveSeparator` re-reads settings). Reproduced before/after with a mock-`pi` harness: `resume`/`new`/`fork`/`reload` went from 0 `setStatus` calls to the full six-field idle line.
- Also: `injectFlags` typed as `injectFlags<T>(body: T): T | string` (pass-through at its boundary) instead of `unknown`, dropping the now-unneeded `as BodyInit` cast.
- `npm test` green (stats + tap), strict tsc clean.

## 2026-08-27 — Per-turn draft figures from final-chunk timings; `/metrics` removed (change `draft-acceptance-mean-len`)

- Root cause of the permanently-`-` `draft` field: the spec figure was computed from deltas of the Prometheus spec counters polled from `/metrics` every 2 s while generating, but llama.cpp merges per-slot spec stats into those counters only when a task completes (`metrics_on_prediction`) — during a turn the counters are frozen, so every in-turn delta was 0. The counters are also server-cumulative, the wrong basis for a per-turn figure.
- The `draft` field now shows the active model's per-turn figures, computed at turn end from the tapped stream's final chunk `timings` (llama.cpp's own per-task formulas, the same numbers as its stdout line): acceptance ratio `draft_n_accepted / draft_n` (rounded integer %) and mean acceptance length `1 + accepted / (predicted_n − accepted)` (1 decimal, `x`; double-rounded through 2 decimals to match the server's 2-dec stdout value, e.g. `2.85 → 2.9x`).
- **Persistent display** (per user direction): the last computed pair is shown in every phase (idle, prefill, generating, lifecycle) and updates at the next turn's end; it resets to `-` only when the active model changes (model switch `reset()`s; a superseding stream clears only the turn windows via `resetTurn`).
- **Empirical, spec-type-agnostic support detection** (per user direction — no spec-type allow/deny lists): a completed turn that generated ≥ 1 token but reported no draft stats → `not supported` (literal text); the verdict is never latched — a later stats-bearing turn self-heals to the value; a stats-less turn after a computed value keeps the value; final chunks omitting the draft fields entirely (older server builds) are treated as stats-less turns without error.
- **`tg3s`/`pf3s` minimum-span floor**: `speed()` returns no figure while the window's sample span is under 500 ms (`MIN_SPAN_MS`, rendered `0/s` via the existing null path). Verified bug: a turn-start MTP burst (2–4 tokens within ≤2 ms) divided a small delta by a millisecond span and produced 1000 t/s spikes gliding down over ~2.5 s. Full 3 s window math unchanged.
- **BREAKING (display only)**: `SpecCounters`, `specAcceptance`, `updateSpec`, `specPrev`/`specValue` (`stats.ts`) and `pollMetrics`, `parseMetric` (`index.ts`) deleted; the 2 s timer keeps only the lifecycle poll. Zero `/metrics` and `/slots` requests in any phase; router load ≈0.5 req/s flat.
- Tests: `stats.test.ts`'s spec-delta section replaced by the draft state machine + formulas + per-phase rendering (incl. both worked cases `811/349 → 43% 2.9x` and `48/40/33 → 83% 3.2x`, `accepted=0 → 0% 1.0x`, absent fields, every transition incl. self-heal, the min-span floor cases); `tap.test.ts` covers the figure appearing on the post-turn idle line, persistence through the next turn's prefill/generating lines, the second turn's update, `not supported` after a fresh model, model-switch reset, abort semantics, and zero `/metrics` + `/slots` over the whole run; `tests/live.ts` asserts a real draft figure and `metrics=0`.
- Live (aurora router, MTP model Qwen3.6-35B-A3B): PASS — a real turn renders the actual figure (e.g. `draft 72% 3.1x`), `metrics=0`, `slots=0`. `npm test` green, strict tsc clean, `openspec validate --strict` valid.
- Dev-deps: `typescript` + `@types/node` (and `@earendil-works/pi-coding-agent` for the local type check) were missing in this environment and are now devDependencies so `npx tsc -p .` runs standalone.

## 2026-08-27 — Uniform six-field footer + `separator` setting (change `always-visible-footer-fields`)

- **BREAKING (display format only)**: the footer line is now always six fields in fixed order — `model · status · pf · tg3s · cache · draft` — regardless of phase; a metric that is not actively updating shows `-` (previously the line shape changed per phase: `model · idle`, `model · pf …`, `model · tg …`).
- New status field: `idle`, `active` (a tapped turn mid-turn, prefill or generating), `loading`, `unloaded`, `offline`.
- `stats.ts`: `renderLine(model, view, sep = " · ")` is now a single uniform formatter; the phase still decides which fields carry values (`RenderView` unchanged).
- `index.ts`: `separator` setting read once per `session_start` — project `.pi/settings.json` (trusted projects only, via `CONFIG_DIR_NAME`/`ctx.isProjectTrusted()`) > global `~/.pi/agent/settings.json` (`getAgentDir()`) > default `" · "`; each file read in try/catch, only a non-empty string accepted, invalid/corrupt → default, never crashes; passed into all three `renderLine` call sites.
- Tests: `stats.test.ts` re-pointed to the six-field format (plus custom-separator and null `spec`/`cachePct` cases); `tap.test.ts` exact lines updated + separator case (trusted temp project dir; hermetic global settings dir via `PI_CODING_AGENT_DIR`); `tests/live.ts` asserts six fields on every line and the non-llama clear. `npm test` green, strict tsc clean.
- Live (aurora, Chat model Qwen3.6-35B-A3B): one full prefill→generating→idle turn, every footer line uniformly six-field, non-llama model clears the status, zero `/slots` requests.
- `README.md`: examples replaced (verified byte-for-byte against `renderLine` output) and the `separator` setting documented (location, precedence, default, lifetime).
## 2026-08-27 — Archived `sse-tap-stats`, synced main spec

- Synced the delta into `openspec/specs/llama-stats-footer/spec.md`: added `Concurrent stream handling`, rewrote the 7 modified requirements around the SSE tap (lifecycle, idle, prefill, generation, window speeds, KV-cache ratio, model lifecycle), removed `Busiest slot selection` (no `/slots` polling). `openspec validate --specs` passes.
- Moved the change to `openspec/changes/archive/2026-08-27-sse-tap-stats/`. No active changes remain.

## 2026-08-27 — SSE stream tap replaces /slots polling (change `sse-tap-stats`)

- In-turn stats now come from an in-process tap on the active model's `/chat/completions` SSE response (`globalThis.fetch` wrapper, restored on `session_shutdown` / non-llama switch): injects `return_progress` + `stream_options.include_usage` into string request bodies (mutation skipped on parse failure or non-string body), parses `prompt_progress` events, per-token deltas (`content` **and** `reasoning_content` — thinking models), and the final `usage`/`timings` chunk; re-emits the original response bytes unchanged, so the agent's stream is untouched.
- `stats.ts`: `observe()`/`SlotView`/`pickSlot`/counter-drop turn detection replaced by `onProgress` / `onToken` / `onStreamEnd` over the same state, plus pure SSE parsing (`parseChunk`) and latest-wins stream tracking (`createTracker`/`classify`/`openStream`/`closeStream`). Windows, cache %, spec acceptance, and rendering survive intact.
- The final chunk's server `timings` are recorded as the turn's last window sample (total basis: `prompt_n + cache_n`, since `prompt_n` excludes cached tokens), so the window's final pf cross-checks `timings.prompt_per_second` (`LLAMA_STATS_DEBUG` logs both).
- Removed: the 500 ms `/slots` polling loop, `parseSlot`, the `slotsInFlight` guard, and slot selection — zero `/slots` requests now.
- Re-gated: `/metrics` runs only while a tapped stream is generating (was: model loaded); `/v1/models` @ 2 s kept for lifecycle, with its render suppressed while a stream is active; status-poll failure with no stream → `· offline`; stream abort/error → idle, not offline.
- Concurrent turns: latest-wins — a new stream supersedes the active one (fresh windows), late events from superseded streams are dropped, and closing a superseded stream does not idle the newest one.
- Router load: active turn ≈3.0 → ≈1.0 req/s; loaded-idle 1.0 → 0.5 req/s; unloaded unchanged (0.5).
- Tests: `stats.test.ts` re-pointed to stream events; `tap.test.ts` added (pass-through bytes, target-only flag injection, phase sequencing, offline/abort semantics, fetch restore); `tests/live.ts` for manual live runs. `npm test` green, strict tsc clean, live-verified on aurora (Chat model full turn incl. spec figure, subagent concurrency, mid-turn model switch, `unloaded → loading → idle`, non-llama clear).

## 2026-08-26 — pi package layout (restructure)

- Restructured the repo into a publishable pi package (same layout as `gsanhueza/pi-llama-cpp`): `package.json` with a `pi` manifest (`pi.extensions: ["./src/index.ts"]`, `pi-package` keyword), source in `src/`, tests in `tests/`, `tsconfig.json`, `README.md`.
- Moved `.pi/extensions/llama-stats/{index,stats,stats.test}.ts` → `src/{index,stats}.ts` + `tests/stats.test.ts`; fixed the test import path and run command (`npm test`, jiti dev-only runner — this node build lacks `--experimental-strip-types`).
- `.gitignore` reverted to plain `.pi/` (no un-ignore exception needed anymore).
- Local dev now consumes the package like any user: `pi install -l --approve .` (repo root registered as a project package in `.pi/settings.json`, gitignored). `pi config -l` shows `.. → [x] src/index.ts`.
- No code changes to the extension itself; tests + strict tsc re-verified against the new layout.

## 2026-08-26 — llama-stats footer extension (change `llama-footer-stats`)

- Added `.pi/extensions/llama-stats/` — a pi extension that renders live llama.cpp stats in the footer while the active model is a `llama-server` provider.
- Stats: tg3s (gen speed, 3 s window), pf3s + prefill progress bar, KV-cache reuse, spec acceptance.
- `stats.ts` = pure logic (window math, turn detection, slot pick, spec acceptance, rendering); `index.ts` = pi wiring; `stats.test.ts` = assert checks (run via jiti).
- Status-first polling: `/v1/models` (2 s) gates `/slots` (500 ms) + `/metrics` (2 s). Non-loaded model → `· loading` / `· unloaded`; fetch failure → `· offline`. Avoids the misleading `offline` that `/slots` 500s produce during model load/unload.
- Live-verified against the aurora router on both the Coder (Qwen3.8-27B) and Chat (Qwen3.6-35B-A3B) models.
- Initialized git; `.gitignore` now tracks `.pi/extensions/` (the extension source) while ignoring the rest of `.pi/`.
