# Design — draft-acceptance-mean-len

## Context

- The current `draft` path: `pollMetrics()` fetches `/metrics?model=<id>` every 2 s **only while a turn is generating**, parses `spec_decode_num_drafts_total` / `spec_decode_num_accepted_tokens_total`, and renders `1 + Δaccepted/Δsteps` via `updateSpec()`/`specAcceptance()` in `stats.ts`.
- Root cause (verified live, 2026-08-27): llama.cpp's `metrics_on_prediction()` merges per-slot spec stats into those Prometheus counters **only when a task completes**. During a generating turn the counters are frozen, so every in-turn poll delta is 0 → figure always null → field always `-`. A 39 s generating turn with 6 polls produced no figure; the counters moved only after the turn ended. Repro: `tests/live.ts`-style harness against `aurora` router, Qwen3.6 with draft-mtp.
- The tap already parses the final chunk's `timings` (for the pf cross-check): `parseChunk` → `{ kind: "usage", timings }` → `onStreamEnd`. The same `timings` object carries the per-task draft stats — llama.cpp's `server_slot_stats::to_json()` emits `draft_n` and `draft_n_accepted` **iff** the task's spec engine ran the counter path (`n_draft_tokens > 0`).
- llama.cpp's stdout line `draft acceptance = 0.43033 (349 accepted / 811 generated), mean len = 2.85` is computed in `print_timing()` from exactly those per-task counters, so the wire data and the stdout data are the same numbers.
- Six-field layout (`model · status · pf · tg3s · cache · draft`) and `separator` setting already ship (change `always-visible-footer-fields`; main spec sync pending — see Ordering).

## Goals / Non-Goals

**Goals:**

- `draft` field shows per-turn acceptance ratio + mean length, computed from the tapped stream's own final chunk, with the server's own formulas.
- Persistent model-level display (last value across all phases), empirical spec-type-agnostic support detection, `not supported` state, zero extra server requests.
- Delete the dead `/metrics` path entirely.
- `tg3s`/`pf3s` never divide by millisecond spans: a 500 ms minimum window floor kills the turn-start burst spikes (full 3 s math unchanged).

**Non-Goals:**

- No in-turn (live-updating) draft figure — the data simply does not exist mid-turn (counters merge at task end).
- No parsing of `--spec-type` or any server arguments; no allow/deny lists of spec types.
- No per-position acceptance breakdown (the stdout `acc per pos` line) — not requested.
- No change to the tap's pass-through guarantee or to `pf`/`tg3s`/`cache` behavior.

## Decisions

### D1 — Data source: final-chunk per-turn `timings`, not `/metrics`

The final chunk's `timings.draft_n` / `timings.draft_n_accepted` are per-task, arrive in the stream already tapped (zero extra requests), and are emitted exactly when the counters ran. `/metrics` is wrong on three counts: timing (frozen during the turn), basis (cumulative server totals, not per-turn), and load (an extra request). `/slots` per-slot stats never expose the draft counters at all (checked `to_json` in `server-context.cpp`).

### D2 — Formulas (reusing llama.cpp's `print_timing` math)

From `timings`: `draftN` = draft tokens generated, `accepted` = draft tokens accepted, `predictedN` = generated tokens.

- **acceptance ratio** = `accepted / draftN` — displayed `Math.round(ratio * 100)` + `%`.
- **verification steps** = `predictedN − accepted`. Derivation: each verification step yields exactly 1 bonus token (always kept) plus its accepted drafts, so total generated = steps + accepted. Cross-checked against live data: turn with `predicted_n=48, draft_n=40, accepted=33` → steps 15, mean len `1 + 33/15 = 3.2x`; the user's log line `349 accepted / 811 generated, mean len = 2.85` → steps 189 (`1 + 349/189 = 2.847 → 2.9x`), ratio 43%.
- **mean acceptance length** = `1 + accepted / steps` — displayed with 1 decimal + `x`. `steps ≥ 1` is guaranteed whenever the verdict applies (a completing turn that generated ≥ 1 token has steps + accepted = predictedN ≥ 1 and accepted ≤ steps·nmax), so no divide-by-zero branch is needed; a defensive `steps > 0` guard still applies (field keeps its previous state if it ever fires).

`TurnTimings` gains `draftN: number | null` and `draftNAccepted: number | null` (null = field absent — older builds); `parseChunk` extracts them with the existing `num()` helper.

### D3 — Empirical support detection (no spec-type lists)

State machine in `stats.ts` (pure, part of `StatsState`), per active model:

```
           turn ends, draftN > 0
   ┌──────────────────────────────────────┐
   ▼                                      │
none ──► value ────────────────────────────┘  (update value)
  │        │  turn ends, no draft stats: keep value
  │        ▼
  └──► unsupported (only from none, verdict below)
            │  turn ends, draftN > 0 → value (self-heal)
```

- `value`: `{ ratioPct, meanLen }` — last computed pair, shown in all phases.
- `unsupported`: verdict = a completed turn (final chunk with `timings`, `predictedN ≥ 1`) ended without draft stats **and** the state was `none`. Never latched: stats flip it to `value`.
- `none`: shows `-`; also the state after `reset()` (model switch).

Why this is the reliable spec-type-agnostic detection: the server emits the fields iff its counter path ran for the task — whatever the spec type is named. Ngram-only types (empirically: `ngram-map-k4v`/`ngram-mod` turns leave all counters at 0) simply never emit the fields → verdict after the first real turn. Future types that do run the counter path are automatically supported. The one-turn delay to the verdict is the price of not shipping a type list; the state machine self-corrects in both directions.

Rejected alternatives: parsing `--spec-type` from `/v1/models` `status.args` (mixes emitting and non-emitting types — e.g. `draft-mtp,ngram-map-k4v,ngram-mod` — so any static mapping drifts); `/metrics` after-turn delta (adds a request, and the per-model-server cumulative counters still can't prove *this model's* capability once any other model on that server instance had activity).

### D4 — Rendering

`renderLine` gains the draft state as part of the view: the `draft` field renders `-`, `not supported`, or `<ratio>% <meanLen>x` (e.g. `draft 43% 2.9x`). The field is the declared exception to the six-field live-value rule (see spec delta, `Uniform footer field layout`). Lifecycle lines (`loading`/`unloaded`/`offline`) render the current draft state too — it is model-level, and `not supported` remains true while unloaded.

### D5 — Deletions

`SpecCounters`, `specAcceptance`, `updateSpec`, `specPrev`/`specValue` (`stats.ts`); `pollMetrics`, `parseMetric` (`index.ts`). The 2 s timer keeps only `pollStatus()`. `reset()` clears the draft state with the rest.

### D6 — Minimum window floor for `speed()`

Verified bug (real `onToken()` harness, 2026-08-27): a turn starting with the MTP burst (2-4 tokens within ≤2 ms) yields `tg3s` = 1000/s (2 tokens / 1 ms span), then glides down over ~2.5 s to the true average. The full-window math was verified correct — the defect is that the partial-window rule bounds the span above (3 s) but not below, so the first seconds divide small deltas by 1-2 ms spans (same-millisecond spans hit `dt <= 0` → `0/s`).

Fix: one floor in the shared `speed()` — `span < MIN_SPAN_MS (500)` → `null`, which the existing `?? 0` view path renders as `0/s`. 500 ms ≈ 8-9 tokens at ~15 t/s: the first displayed figure is already a stable average, and the burst's contribution decays into the window as it ages out. Rejected alternatives: EMA smoothing (changes the metric's meaning, adds a parameter), dropping burst samples (they are real tokens), per-metric windows (the same guard is correct for `pf`, which shares `speed()`).

## Risks / Trade-offs

- [Capable model's first completed turn has no draft activity (e.g. per-request spec disable — pi never sends that) → transient `not supported`] → self-heals as soon as any turn reports stats; the value direction is never regressed by a stats-less turn.
- [Verdict is delayed until the first completed generating turn] → field shows `-` meanwhile; acceptable (model was just selected) and honest (nothing observed yet).
- [Older server build whose `timings` omit the draft fields entirely, on a model that does spec-decode] → shows `not supported` after the first turn. Acceptable: "supported" here means *computable*, i.e. the server reports the counters; the installed build (2026-08-22) does. Documented in README.
- [Concurrent turns] → only the latest (active) stream's end feeds the state machine, consistent with existing latest-wins semantics; superseded streams' final chunks are dropped before `applyEvent`.
- [Two models on the same session over time] → `reset()` on model switch prevents cross-model contamination (existing behavior, now covering the draft state too).
- [Turns shorter than ~500 ms of generation display `0/s` throughout] → honest (no meaningful window yet) and matches the field's existing `0/s` null rendering; the server `timings` cross-check (debug mode) still covers those turns.

## Migration Plan

- Single pi package; no data or config migration. New version: `npm test` + `npx tsc -p .` + live run (`tests/live.ts` extended: draft figure appears, `/metrics` request count is 0).
- **Ordering**: archive `always-visible-footer-fields` (sync its delta into the main spec) before archiving this change — this delta's MODIFIED requirements are based on the six-field main-spec content.
- Rollback: revert the commit; the old `/metrics` path comes back (and remains invisible in practice, as before).

## Open Questions

None — the remaining unknowns (which future spec types emit counters) are exactly what the empirical detection is designed to absorb without code changes.
