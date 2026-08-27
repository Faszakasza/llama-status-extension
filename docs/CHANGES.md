# CHANGES

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
