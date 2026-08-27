## 1. Pure core: draft state + formulas (src/stats.ts)

- [ ] 1.1 Extend `TurnTimings` with `draftN: number | null` and `draftNAccepted: number | null` (null = field absent) and have `parseChunk` extract them from `timings` via the existing `num()` helper; verify with a unit test that a final chunk with `draft_n`/`draft_n_accepted` parses them and one without yields null
- [ ] 1.2 Add the minimum-span floor to `speed()`: `span < 500` (new `MIN_SPAN_MS` const next to `WINDOW_MS`) returns `null` (rendered `0/s` by the existing `?? 0` view path) instead of dividing a small delta by a millisecond span; the full-window math is unchanged; verify with unit tests: a burst of 4 tokens within 2 ms followed by steady 66 ms/token never shows >100/s during the first 2 s, a 3-token 400 ms turn shows `0/s` throughout, and the full-window case (40 tokens over 2 s → 20 t/s) is unchanged
- [ ] 1.3 Add the draft state machine to `StatsState` (`none` / `value { ratioPct, meanLen }` / `unsupported`) with a pure `onTurnEnd(s, timings)` (or fold into `onStreamEnd`): `draftN > 0` → value via the D2 formulas (ratio = accepted/draftN as rounded integer %, meanLen = 1 + accepted/(predictedN − accepted) with the `steps > 0` guard); no draft stats + `predictedN ≥ 1` + state `none` → unsupported; no draft stats + state `value` → keep value; no draft stats + state `unsupported` → keep; verify with unit tests covering: the live case `predictedN=48, draftN=40, accepted=33` → `83% 3.2x`, the log-line case `811/349` steps 189 → `43% 2.9x`, `accepted=0` → `0% 1.0x`, absent fields → treated as no stats, and every state transition including the self-heal from unsupported
- [ ] 1.4 Replace `RenderView.spec` with the draft tri-state and render in `renderLine` as `draft -` / `draft not supported` / `draft <ratio>% <mean>x` in all phases (idle, prefill, generating, loading, unloaded, offline) regardless of `phase`; `reset()` clears the draft state; verify unit tests for the rendered line in each phase and after reset
- [ ] 1.5 Delete `SpecCounters`, `specAcceptance`, `updateSpec`, and `specPrev`/`specValue` from `stats.ts`; verify `npx tsc -p .` is strict-clean and the module still imports without pi

## 2. Wiring (src/index.ts)

- [ ] 2.1 Remove `pollMetrics` and `parseMetric`; the shared 2 s timer keeps only `pollStatus()`; verify `npx tsc -p .` is strict-clean and no `/metrics` string remains in `src/`
- [ ] 2.2 Feed the draft state machine from the stream end: the usage chunk's `timings` (already passed to `onStreamEnd`) drives the verdict/value; the idle render after a stream end shows the updated draft state; superseded (stale) stream ends keep being dropped before `applyEvent` as today; verify `npx tsc -p .` is strict-clean

## 3. Tests

- [ ] 3.1 Rewrite the spec-acceptance section of `tests/stats.test.ts` to the draft state machine + formulas + rendering of task 1 (keep the existing assert style); verify `npm test` passes
- [ ] 3.2 Update `tests/tap.test.ts` end-to-end: a mock stream whose final chunk carries `draft_n`/`draft_n_accepted` → the draft figure appears on the post-turn idle line and persists through the next turn's prefill and generating lines (previous value until the next turn's end), a second turn updates it, a stream whose final chunk has no draft fields after a fresh model → `draft not supported`, and a model_select switch resets to `draft -`; assert **zero** `/metrics` and `/slots` requests over the whole run; verify `npm test` passes
- [ ] 3.3 Update `tests/live.ts`: after one real turn against the router the footer shows a real `draft <n>% <n>x` figure (MTP model), and the request tally asserts `metrics=0`; verify a manual `timeout 90 npx jiti tests/live.ts` run prints PASS with a non-`-` draft figure

## 4. Docs, verification, commit

- [ ] 4.1 Update `README.md` (footer example lines incl. `draft 43% 2.9x` and `draft not supported`, draft-field description: per-turn, persistent, empirical detection, old-build caveat) and `docs/PLAN.md` (stats table: draft source = final-chunk timings, formulas, state machine); verify README examples match `renderLine` output byte-for-byte
- [ ] 4.2 Run full verification: `npm test`, `npx tsc -p .`, `openspec validate --strict`, and the live run of 3.3 (one turn on the MTP model showing the figure; note the ngram-only verdict if such a model is available); verify all pass
- [ ] 4.3 Update `docs/CHANGES.md` (timestamped entry) and `docs/PROGRESS.md` (session section incl. the root-cause findings: counters merge at task end in `metrics_on_prediction`, per-turn `timings` carry `draft_n`/`draft_n_accepted`, ngram types emit no counters); commit and push; verify `git status` clean and remote updated
