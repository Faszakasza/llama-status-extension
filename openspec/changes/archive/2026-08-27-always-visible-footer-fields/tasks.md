## 1. Core rendering (src/stats.ts)

- [x] 1.1 Rewrite `renderLine` as `renderLine(model: string, v: RenderView, sep: string = " · ")`: one uniform line of six fields — model, status, `pf …`, `tg3s …`, `cache …`, `draft …` — joined by `sep`; status maps `prefill`|`generating` → `active`, other phases pass through; non-updating metric fields render `-` (`pf <speed>/s <bar> <pct>%` only in prefill, `tg3s <speed>/s` only in generating, `cache <pct>%` only in prefill with non-null cachePct, `draft <spec.toFixed(1)>x` only in generating with non-null spec); verify `npx tsc -p .` is strict-clean and the module still imports without pi
- [x] 1.2 Re-point the render-line assertions in `tests/stats.test.ts` to the six-field format (idle/prefill/generating/loading/unloaded/offline lines, dash fields, progress bar only in prefill) and add cases for a custom separator and the `spec`/`cachePct` null paths; verify `npm test` passes

## 2. Separator setting (src/index.ts, tests/tap.test.ts)

- [x] 2.1 Resolve `separator` once at `session_start` — project `<cwd>/.pi/settings.json` (via `CONFIG_DIR_NAME`) only when `ctx.isProjectTrusted()`, else global `<getAgentDir()>/settings.json`, else default `" · "`; each file read in try/catch, `.separator` accepted only as a non-empty string; store module-level and pass it into all three `renderLine` call sites (tapped-stream render, lifecycle render, offline render); verify `npx tsc -p .` is strict-clean
- [x] 2.2 Update `tests/tap.test.ts` exact-line assertions to the new format (e.g. prefill line contains `active · pf` and `tg3s -`, final lines `m1 · idle · pf - · tg3s - · cache - · draft -` / `m1 · offline …`), and add one separator case (temp project dir with `.pi/settings.json` `"separator": " | "` → lines joined by ` | `); verify `npm test` passes

## 3. Docs and release verification

- [x] 3.1 Update `README.md`: replace the example block with the six-field lines (idle/active-prefill/active-generating/loading/unloaded/offline) and document the `separator` setting (location, precedence, default `" · "`); verify examples match `renderLine` output byte-for-byte
- [x] 3.2 Run full verification: `npm test`, `npx tsc -p .`, `openspec validate --strict`, and a manual live run against the aurora router (idle line, one full prefill→generating→idle turn, non-llama clear); verify footer shows the uniform six-field line in every phase
- [x] 3.3 Update `docs/PLAN.md` (status + format section), `docs/CHANGES.md` (timestamped entry), `docs/PROGRESS.md` (session section); commit and push; verify `git status` clean and remote updated
