# Design: always-visible-footer-fields

## Context

`renderLine(model, v)` in `src/stats.ts` currently switches on `v.phase` and builds a different line shape per phase (`model · idle`, `model · pf … bar …% cache …%`, `model · tg …/s spec …x`). The `·` separator is hardcoded in those template strings. `RenderView` already carries everything needed (phase, pf, tg, barFrac, cachePct, spec); `src/index.ts` calls `renderLine` at three sites (tapped-stream views, lifecycle poll render, offline render).

pi exports `getAgentDir()` (e.g. `~/.pi/agent`) and `CONFIG_DIR_NAME` (e.g. `.pi`) from `@earendil-works/pi-coding-agent`; the extension already imports from that package. `ctx.isProjectTrusted()` is available in every handler. `getSettingsPath`/`SettingsManager` storage is not exported in a usable form, so settings are read as plain JSON files.

## Goals / Non-Goals

**Goals:**

- One uniform six-field line for every phase, with `-` for non-updating metric fields.
- `separator` setting (project > global > default ` · `), read once per session.
- Pure core stays pi-free: `renderLine` keeps living in `stats.ts` with the separator as a plain parameter.

**Non-Goals:**

- No per-field show/hide, no width-aware truncation, no live reload of settings mid-session.
- No changes to the SSE tap, windows, spec acceptance, or polling cadence.

## Decisions

1. **`renderLine(model: string, v: RenderView, sep: string = " · ")` in `stats.ts`** — a single formatter, no per-phase switch on line shape. Status mapping: `prefill`|`generating` → `active`; `idle`/`loading`/`unloaded`/`offline` pass through. Field values per phase:
   - `pf`: `<speed>/s <bar> <pct>%` while prefill (bar = processed/total, pct = round(100·barFrac)), `-` otherwise
   - `tg3s`: `<speed>/s` while generating, `-` otherwise
   - `cache`: `<pct>%` while prefill and `cachePct != null`, `-` otherwise
   - `draft`: `<spec.toFixed(1)>x` while generating and `spec != null`, `-` otherwise
   Line: the six fields (model, status, `pf …`, `tg3s …`, `cache …`, `draft …`) joined by `sep`, each metric field as `<label> <value-or-dash>`.
   *Alternative considered:* render in `index.ts` with pi access. Rejected — formatting stays testable in `stats.test.ts` with no pi import, and the separator is just a string.
   *Alternative considered:* extend `RenderView` with per-field "updating" booleans. Rejected — phase already determines which fields update; `RenderView` shape is unchanged.

2. **Separator resolution in `index.ts` at `session_start`** — module-level `let separator = " · "`, set once from, in precedence order:
   1. `join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")` — only when `ctx.isProjectTrusted()`
   2. `join(getAgentDir(), "settings.json")`
   Each file: read + `JSON.parse` in try/catch, take `.separator`, accept only a non-empty string, else fall through. Unreadable/corrupt files and wrong types never throw. All three `renderLine` call sites pass the current value.
   *Alternative considered:* pi's `SettingsManager`. Rejected — its project storage is not exported; a 10-line JSON read covers one key that pi itself ignores.
   *Alternative considered:* re-read on every render. Rejected — rendering fires per SSE event; a session-scoped read is the ponytail version. A settings edit takes effect at next session start.

3. **Label vocabulary** — `pf`, `tg3s`, `cache`, `draft` (user-chosen); model and status fields are unlabeled. `draft` shows the spec-acceptance figure (metric name unchanged internally; only the display label differs).

## Risks / Trade-offs

- [Line is ~50-60 chars, longer than today's idle line] → the `separator` setting lets users shorten it (e.g. `|`); the uniform layout is the point of the change.
- [Corrupt or mistyped `separator` in settings.json] → try/catch + type/length validation falls back to the default; extension never crashes.
- [Project trust decided at startup; a trust revocation mid-session keeps the project separator] → re-read happens at `session_start`; a restart picks up the default. Acceptable for a cosmetic setting.
- [Default output is longer than the old per-phase lines] → documented as a display-format breaking change in the proposal; no data or API change.

## Migration Plan

No data migration. Update `tests/stats.test.ts` (render-line assertions) and `tests/tap.test.ts` (exact-line assertions like `m1 · idle`) to the new format; update `README.md` examples and document `separator`. Rollback = revert the commit; no persisted state.

## Open Questions

(none)
