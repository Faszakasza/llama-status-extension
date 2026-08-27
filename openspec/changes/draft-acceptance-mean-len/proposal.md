# Proposal: draft-acceptance-mean-len

## Why

The `draft` footer field never shows anything. Root cause (reproduced live): the extension computes spec acceptance from deltas of Prometheus counters (`spec_decode_num_drafts_total`, `spec_decode_num_accepted_tokens_total`) polled from `/metrics` every 2 s while a turn is generating. But llama.cpp merges per-slot spec stats into the Prometheus counters only when a task completes (`metrics_on_prediction`), so during an active generating turn the counters are frozen — every in-turn poll delta is 0, the figure is always null, and the field renders `-`. A 39 s generating turn with 6 `/metrics` polls produced zero draft figures; the counters only move after the turn ends. The counters are also cumulative server-wide totals, the wrong basis for a per-turn figure.

Meanwhile the exact data llama.cpp's own stdout reports once per task (`draft acceptance = 0.43033 (349 accepted / 811 generated), mean len = 2.85`) is already on the wire: the tapped stream's final chunk carries per-turn `timings` including `draft_n` and `draft_n_accepted`.

## What Changes

- The `draft` field shows two per-turn figures — the **acceptance ratio** (`draft_n_accepted / draft_n`, e.g. `43%`) and the **mean acceptance length** (`1 + accepted / verification-steps`, e.g. `2.9x`, verification-steps derived as `predicted_n − accepted`) — computed at turn end from the final chunk's `timings`, using the same formulas as llama.cpp's per-task `print_timing` stdout line.
- **Persistent display** (per user direction): the `draft` field keeps showing the last computed value in every phase — idle, prefill, generating, lifecycle alike — and updates when a new pair is computed at the next turn's end. During a new turn it shows the previous turn's figures until that turn's end computes its own. The field resets to `-` when the active model changes.
- **Empirical, spec-type-agnostic support detection** (per user direction — no whitelist/blacklist of spec-type names): a model is considered capable once any of its turns' final chunks report draft stats; a model that completes a turn generating at least one token but whose final chunk reports no draft stats is shown as **`not supported`** (literal text in the field). A later turn that does report stats flips the field back to the computed value (self-healing; `not supported` is never latched). Whether a spec type emits these counters is a server property the extension never needs to know — the presence of the per-turn fields is itself the detection.
- Turn without draft activity: the field keeps its current state (last value, `not supported`, or `-`).
- **BREAKING (display only)**: the spec figure is no longer computed for the generating phase — it was never actually visible in practice (always `-`), so no working behavior is removed. The `draft` field becomes the exception to the six-field layout's "live value only while updating" rule.
- `/metrics` polling is removed entirely (the spec counters were its only consumer). Router load drops from ≈1.0 req/s during a turn to ≈0.5 req/s flat (lifecycle `/v1/models` poll only, no in-turn requests at all).
- `SpecCounters`, `specAcceptance`, `updateSpec`, `pollMetrics`, `parseMetric` are deleted from `stats.ts`/`index.ts`.
- Older server builds without the `draft_n`/`draft_n_accepted` fields degrade gracefully (no crash; field keeps its previous state).
- **tg3s/pf3s minimum-window floor** (verified bug): `speed()` divides a small token delta by a millisecond span at turn start (MTP burst: 2-4 tokens within ≤2 ms → 1000/s spikes that glide down for ~2.5 s). The full 3 s window math is correct and unchanged; `speed()` now returns no figure while the sample span is under 500 ms (rendered `0/s` via the existing null path).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `llama-stats-footer`: a new `Draft spec-decoding figures` requirement (per-turn computation from final-chunk timings, persistence, empirical support detection with the `not supported` state); `Uniform footer field layout`, `Idle phase display`, `Prefill phase display`, and `Generation phase display` are modified (the `draft` field is persistent model-level state, no longer a live generating-only figure); `Model lifecycle and unreachable server` is modified (no `/metrics` poll of any kind).

## Impact

- `src/stats.ts`: `TurnTimings` gains `draftN`/`draftNAccepted` (nullable, absent on old builds); `parseChunk` extracts them; a small draft state machine (`-` / value / `not supported`) with the transitions above; `RenderView.spec` is replaced by the draft tri-state; `renderLine` renders `NN% N.Nx` / `not supported` / `-`; `SpecCounters`/`specAcceptance`/`updateSpec`/`specPrev`/`specValue` deleted; `speed()` gains the 500 ms minimum-span floor (span < 500 ms → `null`).
- `src/index.ts`: `pollMetrics` + `parseMetric` deleted; the shared 2 s timer keeps the lifecycle poll only; stream-end handling feeds the draft state machine from the final chunk's `timings`. No change to the SSE tap's byte pass-through (it already parses the final chunk's `timings`).
- `tests/stats.test.ts`, `tests/tap.test.ts`, `tests/live.ts`: spec-delta tests replaced with final-chunk-timings tests (formulas, state machine, persistence, `not supported` verdict + self-heal); live run asserts **zero** `/metrics` requests and a real draft figure.
- `README.md`, `docs/PLAN.md`, `docs/CHANGES.md`, `docs/PROGRESS.md`: footer example lines and the draft-field description updated.
- No new dependencies; no change to the pi API surface; no change to the response bytes re-emitted by the tap.
- Ordering: this delta's MODIFIED requirements are based on the main spec after `always-visible-footer-fields` (six-field layout) is synced — archive that change before this one.
