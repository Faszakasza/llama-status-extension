## Context

pi's extension API surfaces two model-relevant events: `session_start` (carries `reason` and the already-restored `ctx.model`) and `model_select` (fires only on user-driven switches — `setModel`/`cycleModel` in pi's session runtime — and only when the model actually changes). Verified against the installed pi 0.84.3 bundle: the `switchSession`/`newSession`/fork/reload paths construct the runtime with the model already set and emit `session_start` with `reason` `resume` / `new` / `fork` / `reload` respectively, with **no** `model_select` emission. The extension previously gated on `reason === "startup"`, so only fresh sessions ever activated. See proposal.md — Why.

## Goals / Non-Goals

**Goals:**

- The footer is active for the current llama-server model in every kind of session, not just fresh ones.
- Re-activation is side-effect-free: no timer leaks, no double taps, no state mixing.

**Non-Goals:**

- No new pi API usage, no change to the tap/poll mechanics, no change to `src/stats.ts`.
- No mid-session settings reload beyond what `resolveSeparator` already does per `session_start`.

## Decisions

- **Apply the model on every `session_start` reason, rather than waiting for `model_select`.** `model_select` is emitted exclusively by user actions (`setModel`/`cycleModel`); the runtime-construction paths (resume/new/fork/reload) never emit it, so no subset of the model events covers all activations. `session_start` does: it fires exactly once per runtime construction with the final model already in `ctx.model`. Alternative considered — hooking both `session_start(reason != "startup")` and `model_select` — is the same fix with one more branch; the unconditional `applyModel(ctx)` in the `session_start` handler is strictly shorter and `model_select` already routes through the same function for switches.
- **Rely on the existing `start()`/`stop()` pair for idempotency.** `start()` already calls `stop()` first (clears the poll timer, restores `globalThis.fetch`, clears the status) and only resets window/draft state when the model identity changed. Re-firing `applyModel` for the same model therefore costs one timer restart and one immediate `pollStatus()`; draft state (model-level) is preserved.
- **Retype `injectFlags` to `<T>(body: T): T | string`.** The function passes non-string bodies through unchanged; `unknown` return forced an `as BodyInit` cast at the call site. The generic boundary type makes the pass-through honest and removes the cast.

## Risks / Trade-offs

- [A `session_start` for a non-llama model calls `applyModel` → `stop()` on a fresh session] → `stop()` is already null-safe (`ui?.setStatus`, timer/tap guards); behavior identical to the non-llama clear path.
- [Separator re-read on every `session_start`] → two small JSON file reads per session activation; `resolveSeparator` was already per-`session_start`, unchanged.
- [If a future pi emits `model_select` on resume as well] → double activation is already idempotent; no action needed.

## Migration Plan

Single commit to `src/index.ts` + docs; no user-facing config. Activation in a running TUI: `/reload` (re-runs `session_start`) or restart. Rollback: revert the commit — behavior returns to the pre-fix (fresh-sessions-only) state, which was never spec'd.
