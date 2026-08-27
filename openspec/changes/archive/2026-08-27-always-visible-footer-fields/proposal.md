# Proposal: always-visible-footer-fields

## Why

The footer currently swaps whole line layouts per phase (`pf …` while prefilling, `tg …` while generating, bare `· idle` between turns), so the position of any given figure moves and absent metrics are invisible — the user can't tell whether a stat is zero, not updating, or unsupported. The field separator (`·`) is also hardcoded, so users with narrow terminals or terminal themes where the middle dot renders poorly cannot adapt it.

## What Changes

- **BREAKING (display format only)**: the footer line always shows all six fields in a fixed order: model (no label), status (no label), `pf`, `tg3s`, `cache`, `draft` — regardless of agent status. The line no longer changes shape per phase; only the field values do.
- New **status** field: `idle`, `active` (any tapped stream mid-turn, prefill or generating), `loading`, `unloaded`, `offline`.
- A metric field that is not actively updating shows `-` (e.g. `tg3s` while prefill is running, `pf`/`cache`/`draft` while generating, all four while idle/loading/unloaded/offline).
- The progress bar (processed/total) stays attached to the `pf` field, visible only while prefilling.
- New `separator` setting in pi's `settings.json`: the literal string joining the fields. Project `.pi/settings.json` wins over global `~/.pi/agent/settings.json` (when the project is trusted). Default when not configured: the current dot (`·` with a space each side), so default output is byte-identical to today's separator.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `llama-stats-footer`: the per-phase display requirements (idle, prefill, generation, lifecycle lines, KV-cache ratio) all change to the uniform six-field layout with `-` for non-updating metrics; two new requirements are added (uniform field layout with the status vocabulary; configurable field separator).

## Impact

- `src/stats.ts`: `renderLine` rewritten as a single six-field formatter taking the separator; `RenderView` unchanged (phase still drives which fields show values vs `-`). Tests in `tests/stats.test.ts` updated for the new line format.
- `src/index.ts`: read `separator` once at `session_start` (project settings only when trusted, falling back to global, then default); pass it into `renderLine`. No polling or tap behavior changes.
- `README.md`: update the displayed examples and document the `separator` setting.
- No new dependencies; no change to the SSE tap, windows, spec acceptance, or polling. Coexistence with pi-llama-cpp-stats unaffected.
