## Why

The footer status line was empty in any session that was not a fresh startup (resumed, `/new`, forked, or reloaded sessions): the extension applied the active model only on `session_start` with `reason === "startup"`, but pi emits `session_start` with reasons `resume` / `new` / `fork` / `reload` on those paths and — crucially — does **not** emit `model_select` there (the model is restored into the runtime at construction; `model_select` fires only on user-driven `setModel`/`cycleModel`). So `target` stayed null: no fetch tap, no lifecycle poll, no `ui.setStatus` call at all. Every earlier live test passed because they ran in fresh sessions, which masked the regression. The symptom looked like a conflict with the powerline footer (other extensions' statuses still rendered), but powerline's `extension_statuses` segment faithfully renders whatever keys exist — the key simply was never set.

## What Changes

- `src/index.ts`: the `session_start` handler applies the active model for **every** reason (`startup`, `resume`, `new`, `fork`, `reload`), not only `startup`. `model_select` handling for mid-session switches is unchanged. Application is idempotent — `start()` re-runs `stop()` first — so a repeat `session_start` for the same model re-resolves the separator and restarts the lifecycle poll without leaking timers or taps.
- `src/index.ts`: `injectFlags` retyped from `(body: unknown): unknown` to `<T>(body: T): T | string` (pass-through at its boundary); the now-unneeded `as BodyInit` cast is dropped.
- No behavior change for fresh `startup` sessions; non-llama models still clear the status line.
- This change was implemented and verified first (commit `a06b106`, mock-`pi` harness: all five reasons now produce the six-field idle line against the live router); the proposal is captured retroactively because the change was fixed before an OpenSpec change was opened.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `llama-stats-footer`: the **Footer status line lifecycle** requirement gains explicit session-activation semantics — the active model is applied on every `session_start` reason, and because `resume` / `new` / `fork` / `reload` arrive without a `model_select` event, those reasons alone are sufficient to bring the footer back (scenario added).

## Impact

- Code: `src/index.ts` only (one handler branch + a type annotation). `src/stats.ts` untouched.
- Behavior: sessions that previously showed no footer line at all now show it immediately after activation (lifecycle poll starts within one 2 s tick; idle line renders as soon as the model is loaded).
- Tests: covered by the existing tap/stats suites (no new test file); verification via a mock-`pi` harness over all five `session_start` reasons.
- No dependency, API, or packaging changes.
