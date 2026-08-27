# llama-status-extension

Pi agent extension that shows live stats for the **active** llama.cpp / llama-server model in the status footer, while your session runs on it:

```text
Qwen3.6-35B-A3B · active · pf 547/s ▓▓▓▓▓░ 85% · tg3s - · cache 0% · draft -   ← prefill
Qwen3.6-35B-A3B · active · pf - · tg3s 40/s · cache - · draft 7.0x              ← generating (spec decoding)
Qwen3.6-35B-A3B · idle · pf - · tg3s - · cache - · draft -                      ← loaded, waiting
Qwen3.6-35B-A3B · loading · pf - · tg3s - · cache - · draft -
Qwen3.6-35B-A3B · unloaded · pf - · tg3s - · cache - · draft -
Qwen3.6-35B-A3B · offline · pf - · tg3s - · cache - · draft -
```

The line always shows all six fields in a fixed order — model, status (`idle` / `active` / `loading` / `unloaded` / `offline`), `pf`, `tg3s`, `cache`, `draft` — regardless of phase; a metric that is not actively updating shows `-`.

- **tg3s / pf3s**: per-second token counts over a 3 s sliding window (no EMA smoothing), plus a 6-segment prefill progress bar (processed/total).
- **cache**: KV-cache reuse of the current turn (live `cache` count from the stream's progress events vs processed tokens).
- **draft**: server-wide spec-decoding acceptance = `1 + Δaccepted/Δdraft-steps` (Prometheus counters), shown in the `draft` field only while generating and draft activity is advancing.
- **SSE tap, not polling**: in-turn stats come from an in-process tap on the model's own `/chat/completions` stream. The tap injects `return_progress` + `stream_options.include_usage` into the request body and parses `prompt_progress` events (server-timed), per-token arrivals, and the final `usage`/`timings` chunk — then re-emits the response bytes unchanged, so the agent's stream is untouched. Zero extra requests for in-turn stats.
- **Polling is lifecycle-only**: `/v1/models` every 2 s (loading/unloaded/offline between turns) and `/metrics` every 2 s **only while a turn is generating**. Router load: ≈1.0 req/s during an active turn, ≈0.5 req/s loaded-idle, no `/slots` requests at all.
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

`src/stats.ts` is the pure logic (windows, SSE parsing, stream tracking, spec acceptance, rendering); `src/index.ts` is the pi wiring (fetch tap, lifecycle/metrics polls, event handlers). `tests/live.ts` is a manual live-verification script, not part of `npm test`.
