# PROGRESS

## Session 2026-08-26

Built the llama-stats footer extension (change `llama-footer-stats`) from scratch.

### Exploration

- Confirmed the harness is pi; extension API = `ctx.ui.setStatus` + `pi.on` events; project-local extensions live in `.pi/extensions/<dir>/index.ts` (auto-discovered, `/reload`-able).
- Investigated the live router (`aurora.home.lan:10000`, router mode, speculative decoding on) and the llama.cpp master source to map which stats are actually exposed over HTTP.
- Key findings:
  - `tg3s`/`pf3s` are NOT in any HTTP endpoint — only cumulative per-task counters on `/slots` and Prometheus counters on `/metrics`. So the extension computes 3 s sliding windows client-side from polls (same technique as the llama.cpp Web UI).
  - Router mode requires `?model=<id>`; active model = `ctx.model`, provider id `llama-server=<url>`.
  - Spec counters are server-cumulative; ngram-only spec decode (Qwen3.6) never increments them — only draft-model/MTP (Qwen3.8) does.
  - The router unloads idle models; `/slots` for a non-loaded model returns 500. → status-first gating.

### Implementation

- `stats.ts` (pure) + `stats.test.ts` (assert via jiti) + `index.ts` (wiring). No new dependencies.
- Status-first polling: `/v1/models` (2 s) gates `/slots` (500 ms) + `/metrics` (2 s).

### Verification

- Unit: `stats.test.ts` all checks pass (run through jiti — this node build lacks `--experimental-strip-types`).
- `tsc --noEmit` clean (strict) against the real pi types.
- Live (Chat model, so the Coder context cache is never evicted): full lifecycle `· unloaded → · loading → prefill (pf+bar+cache) → generating (tg+spec) → · idle → clear on non-llama`. Confirmed `/slots` 500s while unloaded.
- Live (Coder model): tg 37–53 t/s tracking, idle transitions, clear on model switch.

### Blockers

- None. (Initial live checks evicted the Coder model's KV cache because the router is single-request; fixed by running load-generating checks against the Chat model.)

### Packaging (restructure, same day)

- User: the `.pi/extensions/llama-stats/` layout is wrong for distribution — pointed at `gsanhueza/pi-llama-cpp` as the reference. That repo is a publishable pi package: root `package.json` with a `pi` manifest (`pi.extensions`), source in `src/`, tests in `tests/`.
- Restructured to match: `git mv` → `src/{index,stats}.ts` + `tests/stats.test.ts`; added `package.json` (pi manifest + `pi-package` keyword, jiti devDep, `npm test`), `tsconfig.json` (mirrors the reference; `allowImportingTsExtensions` for the `.ts` import specifiers), `README.md` (install/usage/dev).
- Local wiring: `pi install -l --approve .` registers the repo root as a project package (`..` in `.pi/settings.json`, gitignored) — the project now consumes its own package the same way any user would; `pi config -l` shows `.. → [x] src/index.ts`.
- `node --experimental-strip-types` does not work in this sandbox's node build (`ERR_NO_TYPESCRIPT`, not compiled with TS support) — tests run through jiti (`npm test`).
- Verified: `npm test` passes, strict tsc clean against real pi types (via a throwaway /tmp tsconfig with a `paths` override — the committed tsconfig mirrors the reference, which relies on pi injecting its own modules into `node_modules` at install time), `openspec validate` still valid.
- Pushed to `Faszakasza/llama-status-extension`. No extension code changed.
