# Tasks: llama-footer-stats

## 1. Setup

- [x] 1.1 Initialize git repo (if absent), commit the openspec planning artifacts, and verify `git status` is clean after the commit
- [x] 1.2 Create `.pi/extensions/llama-stats/` (only `index.ts` is loaded by pi; `stats.ts`/`stats.test.ts` live beside it), and verify the directory is present with no stray files in `.pi/extensions/` root

## 2. Pure stats core (stats.ts)

- [x] 2.1 Implement the 3s sliding-window sample buffer and speed computation (decoded + prompt-processed, partial window for history < 3 s) and verify with assert-based tests for steady, partial-window, and reset cases in `stats.test.ts`
- [x] 2.2 Implement turn detection (new turn ⇔ processed drop or decoded reset to 0), cache-reuse ratio `cache/(cache+processed)`, busiest-slot selection (generating beats prefill, tie-break on tokens in flight), and spec-acceptance `1 + Δaccepted/Δdraft` from cumulative counters, each verified with assert-based tests covering the spec scenarios (two-slot tie-break, zero-token guard, Δdraft=0 hides spec)
- [x] 2.3 Implement footer line rendering for idle / prefill (speed + 6-char bar + percent + cache) / generating (speed + spec) / offline, with `>=1000` → `1.2k` number formatting, and verify with assert-based tests against the exact D9 formats
- [x] 2.4 Run the full check file and verify it passes (this node build lacks --experimental-strip-types, so run through jiti — pi's own TS loader): `node -e "require('<pi-npm>/jiti')(process.cwd(),{interopDefault:true})('./.pi/extensions/llama-stats/stats.test.ts')"` exits 0

## 3. Extension wiring (index.ts)

- [x] 3.1 Resolve the active model + base URL (`ctx.model`, provider id `llama-server=<url>` or `ctx.modelRegistry.getProvider(id).baseUrl`) at session start and on `model_select`; stop polling and clear `ctx.ui.setStatus("llama-stats", …)` when the active model leaves a llama-server provider; reset all stats state on model switch, and verify with LSP diagnostics clean and a live `/reload` in pi
- [x] 3.2 Implement the poll loops — `/slots?model=<id>` at 500 ms and `/metrics?model=<id>` at 2 s — driving the D5 turn state machine, D8 offline rendering (clear window, `· offline`, no stale stats, auto-recovery), and the phase-aware status line, and verify in a live pi session: footer shows `idle` when quiet and the prefill/generating lines during an actual turn
- [x] 3.3 Live end-to-end verification against the aurora router (Qwen3.8-27B): during a real turn observe tg3s tracking ~60–100 t/s, the prefill bar moving with a cache % on cached prompts, and `spec ~1.9x` while generating; on switching to a non-llama model the line disappears, and verify no errors in the pi session log
- [x] 3.4 Implement status-first gating: poll `/v1/models` (2 s) and gate `/slots`+`/metrics` on `loaded`, rendering `· loading` / `· unloaded` / `· offline` appropriately, and verify against the live router (Chat model started unloaded: observed `· unloaded` → `· loading` → prefill → idle, and that `/slots` returns 500 for a non-loaded model)

## 4. Wrap-up

- [x] 4.1 Write/update `/docs` per AGENTS.md (PLAN.md with design + status, CHANGES.md entry, PROGRESS.md session history) and verify the files exist and reflect the implemented behavior
- [x] 4.2 Run `openspec validate llama-footer-stats` and commit the implementation, and verify the change validates and `git log` shows the milestone commit
