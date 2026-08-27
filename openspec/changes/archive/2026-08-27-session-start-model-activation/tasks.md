## 1. Fix

- [x] 1.1 Reproduce: mock-`pi` harness driving `session_start` per reason against the live router — `resume`/`new`/`fork`/`reload` produced 0 `setStatus` calls, `startup` produced the full line
- [x] 1.2 `src/index.ts`: `session_start` handler applies the active model for every reason (drop the `reason === "startup"` gate)
- [x] 1.3 `src/index.ts`: retype `injectFlags` to `<T>(body: T): T | string`, drop the `as BodyInit` cast

## 2. Verify

- [x] 2.1 Mock harness: all five reasons now render the six-field idle line (`Qwen3.8-27B · idle · pf - · tg3s - · cache - · draft -`)
- [x] 2.2 `npm test` green (stats + tap suites)
- [x] 2.3 `npx tsc -p tsconfig.check.json --noEmit` strict-clean
- [x] 2.4 Live activation in the running TUI: `/reload` shows the footer immediately

## 3. Docs & commit

- [x] 3.1 `docs/CHANGES.md` entry with root cause (no `model_select` on resume/new/fork/reload) and the one-line fix
- [x] 3.2 `docs/PLAN.md` "Active model" line updated to reflect per-reason activation
- [x] 3.3 `docs/PROGRESS.md` session entry (diagnosis, ruled-out hypotheses: hollow `node_modules` in the installed clone is harmless via pi's `VIRTUAL_MODULES`; `ctx.isProjectTrusted` exists in 0.84.3)
- [x] 3.4 Commit `a06b106` + push; `git pull` in the installed global clone `~/.pi/agent/git/github.com/Faszakasza/llama-status-extension`
