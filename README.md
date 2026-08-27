# llama-status-extension

Pi agent extension that shows live stats for the **active** llama.cpp / llama-server model in the status footer, while your session runs on it:

```text
Qwen3.6-35B-A3B · active · pf 547/s ▓▓▓▓▓░ 85% · tg3s - · cache 0% · draft 43% 2.9x   ← prefill (figures persist from the last turn)
Qwen3.6-35B-A3B · active · pf - · tg3s 40/s · cache - · draft 43% 2.9x              ← generating
Qwen3.6-35B-A3B · idle · pf - · tg3s - · cache - · draft 43% 2.9x                   ← loaded, waiting (last computed value)
Qwen3.6-35B-A3B · idle · pf - · tg3s - · cache - · draft not supported              ← a completed turn reported no draft stats
Qwen3.6-35B-A3B · idle · pf - · tg3s - · cache - · draft -                          ← before the first turn verdict
Qwen3.6-35B-A3B · loading · pf - · tg3s - · cache - · draft -
Qwen3.6-35B-A3B · unloaded · pf - · tg3s - · cache - · draft -
Qwen3.6-35B-A3B · offline · pf - · tg3s - · cache - · draft -
```

The line always shows all six fields in a fixed order — model, status (`idle` / `active` / `loading` / `unloaded` / `offline`), `pf`, `tg3s`, `cache`, `draft` — regardless of phase; `pf`, `tg3s`, and `cache` show `-` while not actively updating. `draft` is the declared exception: it is persistent model-level state and shows the same value in every phase.

- **tg3s / pf3s**: per-second token counts over a 3 s sliding window (no EMA smoothing), plus a 6-segment prefill progress bar (processed/total). No figure is displayed while the window's sample span is under 500 ms (shows `0/s`), so a turn-start speculative burst (a few tokens within milliseconds) can't spike the speed.
- **cache**: KV-cache reuse of the current turn (live `cache` count from the stream's progress events vs processed tokens).
- **draft**: the active model's per-turn spec-decoding figures, computed when a turn ends from the final chunk's `timings` (same formulas as llama.cpp's per-task stdout line): acceptance ratio `draft_n_accepted / draft_n` (integer %) and mean acceptance length `1 + accepted / (predicted_n − accepted)` (1 decimal, `x`). It is persistent model-level state — the last computed pair is shown in **every** phase (idle, prefill, generating, lifecycle) until the next turn's end computes new figures or the active model changes (reset to `-`). Support is detected empirically, never from spec-type names: a model that completes a turn generating tokens but whose final chunk reports no draft stats is shown as `not supported` (literal text), and a later turn that reports stats replaces it (self-healing). Final chunks that omit the draft fields entirely (older server builds) are treated as a stats-less turn without error.
- **SSE tap, not polling**: in-turn stats come from an in-process tap on the model's own `/chat/completions` stream. The tap injects `return_progress` + `stream_options.include_usage` into the request body and parses `prompt_progress` events (server-timed), per-token arrivals, and the final `usage`/`timings` chunk — then re-emits the response bytes unchanged, so the agent's stream is untouched. Zero extra requests for in-turn stats.
- **Polling is lifecycle-only**: `/v1/models` every 2 s (loading/unloaded/offline between turns). No `/metrics` and no `/slots` requests in any phase. Router load: ≈0.5 req/s flat, no in-turn requests at all.
- **Concurrent turns** (e.g. subagents): latest-wins — the most recently started stream owns the footer; late events from superseded streams are dropped.
- No status line while a non-llama model is active. No required config; provider URLs come from pi's model config.
- **Coexists with pi-llama-cpp-stats**: both patch `globalThis.fetch` and the patches chain safely; its working-message prefill bar becomes a redundant subset of this footer.

## Install

```bash
pi install git:github.com/Faszakasza/llama-status-extension
```

or from a local checkout (project scope):

```bash
pi install -l .
```

## Settings

One optional key, `separator` — the literal string joining the six footer fields:

```json
{ "separator": " | " }
```

- **Location**: project `<project>/.pi/settings.json` (only when the project is trusted), else global `~/.pi/agent/settings.json`.
- **Default**: `" · "` (middle dot, one space each side) — used when `separator` is absent, not a non-empty string, or the settings file is unreadable.
- **Lifetime**: read once per session start; edits take effect on the next session start.

## Development

No runtime dependencies; the only import is `@earendil-works/pi-coding-agent` (provided by pi). `jiti` is a dev-only test runner.

```bash
npm test    # stats.test.ts (pure core) + tap.test.ts (tap integration)
npx tsc -p .                                   # strict type check
LLAMA_STATS_DEBUG=1 pi ...                     # logs the pf window-vs-server cross-check per turn
timeout 90 npx jiti tests/live.ts              # manual live run against the aurora router
```

`src/stats.ts` is the pure logic (windows, SSE parsing, stream tracking, draft state machine, rendering); `src/index.ts` is the pi wiring (fetch tap, lifecycle poll, event handlers). `tests/live.ts` is a manual live-verification script, not part of `npm test`.
