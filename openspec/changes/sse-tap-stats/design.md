## Context

See proposal.md for motivation. Current state: `src/index.ts` runs three poll loops (`/v1/models` 2 s, `/slots` 500 ms gated on model loaded, `/metrics` 2 s gated on model loaded) and `src/stats.ts` turns counter deltas from `/slots` into 3 s windows. Live probe against the aurora router (2026-08-26) confirmed:

- `return_progress: true` + `stream_options.include_usage: true` in the chat-completion body makes the router pass through llama.cpp's `prompt_progress` events (each chunk: `{total, cache, processed, time_ms}`) at ~1.4 Hz during prefill.
- The final chunk carries `usage` (incl. `prompt_tokens_details.cached_tokens`) and a `timings` object with server-computed `prompt_per_second`, `predicted_per_second`, `prompt_ms`, `predicted_ms`.
- Every chunk carries the request's `chatcmpl-…` id, so per-stream correlation is possible in-stream.
- The pi-llama-cpp-stats extension (installed in this environment) proves the `globalThis.fetch` patch + pass-through `ReadableStream` wrapper works in this harness (v0.1.6, chains safely).

## Goals / Non-Goals

**Goals**

- Zero extra HTTP requests for in-turn stats: pf/bar/cache/tg come from the tapped stream.
- Server-timed windows (no fetch-latency skew) + final `timings` recorded as authoritative last sample.
- Keep `/v1/models` @ 2 s (lifecycle) and `/metrics` @ 2 s (spec, only while generating).
- `stats.ts` stays pure and testable with plain objects; rendering format unchanged.

**Non-Goals**

- No new display figures from `timings` (no ETA, no per-turn summary line) — cross-check only.
- No support for API-keyed servers (existing ponytail comment stands).
- No per-model multi-target display; footer is one line for the active model.
- Not making the tap robust to pi changing its request format — target the OpenAI-compatible path pi uses today (`/chat/completions`, streaming).

## Decisions

### D1. Tap mechanism: `globalThis.fetch` patch + pass-through ReadableStream

Same as pi-llama-cpp-stats (proven in this harness). The wrapper only intercepts requests to the **current target's base URL** (not "learn the first llama URL" — the reference's heuristic; we already know the target from `ctx.model`/registry, so we match exactly). Non-target responses pass through the original `fetch` return untouched.

Body mutation: parse the string JSON body once; set `stream: true` is not forced (pi already streams); add `return_progress: true` and `stream_options.include_usage: true` only when the body parses and `stream` is true. On parse failure, pass through unmodified.

**Alternatives considered:**

- pi event hooks on the assistant message stream — no hook exposes the raw chunks with `prompt_progress`; pi's own events are post-parsed and drop vendor fields. Rejected.
- Standalone SSE subscription to the server — llama.cpp exposes no event endpoint for this; rejected.

### D2. Stream state: single active stream, latest-wins, keyed by `chatcmpl-…` id

Each tapped stream opens with a locally generated id at request time and is cross-checked against the `id` in each chunk (cheap, catches router quirks). A new tapped stream for the same target supersedes the old one: `activeStreamId` is replaced, window state resets, and late events whose id ≠ `activeStreamId` are dropped. Stream end (close, cancel/abort, or error) only resets to idle **if it is still the active stream**.

**Rationale:** subagent concurrency can open overlapping streams; the router runs `parallel=1` per model so they serialize server-side anyway, and the footer is one line. Latest-wins is the natural "what is the user watching" answer. (Alternative: per-stream state with a priority rule — more code, same visible result.)

### D3. Event → phase mapping

- **prefill**: progress events with `processed < total` and no content token yet. pf window fed by `{t: time_ms, v: processed}`; bar = `processed/total`; cachePct = `cache/(cache+processed)`.
- **generating**: first chunk with non-empty `delta.content` flips the phase; tg window fed by `{t: Date.now(), v: 1}` per content chunk.
- **turn end**: chunk with `usage` (and/or `[DONE]` line) → record final sample from `timings` (e.g. if `prompt_per_second > 0`, one last pf sample at `prompt_ms/prompt_n` granularity is overkill — instead record `timings` into state and have the *final render* use it as the last sample of the window), then emit the idle line (deferred to the status poll if the model unloads mid-transition is fine — the status poll within 2 s will confirm `loaded → idle`).

Windowing itself stays in `stats.ts` unchanged: `speed(samples, now)` already does "drop >3 s, partial window, delta/delta". Only the sample source changes.

### D4. Lifecycle/metrics gating

- `pollStatus` @ 2 s: unchanged, but its lifecycle render is suppressed while `activeStreamId != null` (a mid-turn poll saying "loaded" must not overwrite the phase line). If a mid-turn poll reports not-loaded, ignore it for display (the stream is the ground truth while open) but keep the value for the post-stream render.
- `pollMetrics` @ 2 s: gate becomes `activeStreamId != null && phase == generating` instead of `modelStatus == loaded`. Spec state (`updateSpec`) unchanged; on turn end the spec figure fades with the generating phase (same as today — the render only shows `spec` in generating).
- `offline`: status poll failure and no active stream → `· offline`. A stream error/abort while a stream was active → treated as turn end (idle), not offline.

### D5. stats.ts surface

```ts
// drops: SlotView, parseSlot callers, pickSlot, counter-drop turn detection
observe() → three pure entry points over the same state:
  onProgress(s, { id, total, processed, cache, timeMs }): RenderView
  onToken(s, { id }): RenderView          // t = caller-supplied now
  onStreamEnd(s, { id, timings? }): RenderView
reset() kept; windows, cachePct, updateSpec, renderLine unchanged.
```

The stream wrapper owns id-matching and supersede-before-calling; the pure functions assume their `id` is the active one.

### D6. Teardown

`session_shutdown` (and model-switch to non-llama): restore `globalThis.fetch`, clear `activeStreamId`. No `beforeunload`-style concerns (node process).

## Risks / Trade-offs

- [pi changes its request shape (non-string body, `Request` object)] → The wrapper handles string bodies; if `init.body` is not a string, skip mutation (tap still works — the router may just not include `prompt_progress`, and the extension degrades to the status line only). Detect-and-degrade, not detect-and-crash.
- [Router strips `prompt_progress` (it doesn't today)] → Degrades to status-poll-only between turns and tg from token arrival; no crash, just missing pf/cache. Live probe is the verification artifact for this.
- [`chatcmpl-…` id missing in some chunk (malformed)] → Fall back to "events belong to the most recently opened stream" (the single-active invariant already holds).
- [Tap adds latency to the agent's stream] → Wrapper only decodes lines already arriving; re-enqueues original bytes. Measured negligible (pi-llama-cpp-stats ships this).
- [Concurrent taps + in-flight guard] → The old `slotsInFlight` guard is gone with `pollSlots`; the wrapper has no reentrancy to guard against.
- [Both this and pi-llama-cpp-stats installed] → Patches chain (each wraps the previous fetch). Both inject the same body flags idempotently. Their working-message bar becomes redundant — document, don't block.

## Migration Plan

Single PR-sized change, no data to migrate:

1. Land the working-tree cleanup first (the uncommitted idle refactor + the one-line test fix `undefined → null` expectation or make `reset()` set `undefined` — decide during implementation; tests green + tsc clean before starting).
2. Replace `pollSlots`/`parseSlot` and repoint `stats.ts` (D5) — `npm test` + `npx tsc -p .` after each step.
3. Add the fetch wrapper + gating changes (D1, D2, D4) — unit: pass-through and id-matching via a fake stream; then live against aurora: Chat model full turn (prefill bar + cache, tg tracking, spec when advancing), subagent concurrent turn, model switch mid-turn, unloaded → loading → idle.
4. Live cross-check: compare the window's final pf vs `timings.prompt_per_second` on the same turn; log both (temporary console line or just eyeballed during verification).
5. Commit, update README/PLAN/CHANGES/PROGRESS, `openspec validate`.

Rollback: revert the commit; the old polling code is self-contained and unchanged until step 2.

## Open Questions

- During implementation: does `reset()`'s current `spec: null` (working tree) keep the render's "hide spec when null/undefined" behavior — verify, not a design fork (render already treats both as hidden).
- Whether to uninstall `pi-llama-cpp-stats` after landing — user's call, post-landing.
