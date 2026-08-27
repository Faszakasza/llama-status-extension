## 1. Baseline cleanup

- [x] 1.1 Decide the `reset()` spec-field convention (working tree sets `null`, test expects `undefined`) and align test or code so `npm test` passes, then commit the working-tree idle refactor as a baseline — verify: `npm test` green, `npx tsc -p .` clean, committed.
- [x] 1.2 Delete `.tmp-llama/` probe artifacts from the tree (untracked scratch from the endpoint map) — verify: `git status --short` shows no `.tmp-llama/`.

## 2. Repoint stats.ts to stream events (D5)

- [x] 2.1 Replace `SlotView`/`pickSlot`/counter-drop turn detection with the three pure entry points over the same `StatsState`: `onProgress(s, now, { total, processed, cache, timeMs })`, `onToken(s, now)`, `onStreamEnd(s, now, { timings? })` — verify: `npx tsc -p .` clean with a temporary stub caller.
- [x] 2.2 Record the final `timings` (prompt_per_second / predicted_per_second) as the turn's last window sample inside `onStreamEnd` — verify: unit test feeds a timings figure and asserts the returned pf/tg sample matches the server value.
- [x] 2.3 Update `tests/stats.test.ts` to the new inputs: window math (partial + steady), prefill bar, cache %, spec persistence, stream-end idle, latest-wins supersede — verify: `npm test` green.

## 3. Fetch tap in index.ts (D1, D2)

- [x] 3.1 Implement the `globalThis.fetch` wrapper: exact-match on the current target base URL, string-body parse + `return_progress`/`stream_options.include_usage` injection (skip mutation on parse failure or non-string body), pass-through `ReadableStream` re-emitting original bytes — verify: unit test with a fake response stream asserts bytes pass through unmodified and events fire.
- [x] 3.2 Implement per-stream id tracking (local id at request time, cross-check against chunk `id`, latest-wins supersede, late events dropped, stream end resets only if still active) — verify: unit test simulates two overlapping streams and asserts only the latest updates state and its close does not idle-out the newer stream.
- [x] 3.3 Wire phases: progress events → `onProgress`, content deltas → `onToken`, usage chunk / close / cancel → `onStreamEnd` + idle line; restore original fetch on `session_shutdown` and on switch to a non-llama model — verify: unit test for event→phase sequencing; `npm test` + `npx tsc -p .` green.

## 4. Re-gate the survivors (D4)

- [x] 4.1 Delete `pollSlots`/`parseSlot` and the `slotsInFlight` guard; keep `/v1/models` @ 2 s with lifecycle renders suppressed while a stream is active; re-gate `pollMetrics` on stream-generating — verify: `npx tsc -p .` clean; unit test (or code-path check) that no request path to `/slots` remains (`grep -n "slots" src/index.ts` shows nothing).
- [x] 4.2 Offline semantics: status-poll failure with no active stream → `· offline`; stream error/abort → idle, not offline — verify: unit test for both transitions.

## 5. Live verification against aurora

- [x] 5.1 Full turn on the Chat model: prefill bar + cache % tracking progress events, tg tracking generation, turn end → idle line, spec figure when counters advance — verify: observed in the pi footer during a real session.
- [x] 5.2 Load check: active turn ≈ 1.0 req/s (status + metrics only), loaded-idle ≈ 0.5 req/s — verify: router log or manual curl timing shows no `/slots` requests.
- [x] 5.3 Cross-check: window's final pf vs the same turn's `timings.prompt_per_second` within a few percent — verify: both figures captured for one turn and compared.
- [x] 5.4 Edge cases: concurrent subagent turn (latest-wins visible), model switch mid-turn (reset + tap re-targets), unloaded → loading → idle lifecycle, non-llama model (status cleared) — verify: each observed in a real session.

## 6. Docs + closeout

- [x] 6.1 Update README (stats sourcing, load numbers, note on coexisting with pi-llama-cpp-stats), PLAN.md, CHANGES.md, PROGRESS.md — verify: files describe the SSE tap, not polling.
- [x] 6.2 `openspec validate --change sse-tap-stats` and commit — verify: validate passes, commit pushed.
