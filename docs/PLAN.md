# PLAN — llama-status-extension

## Goal

A pi extension that displays live statistics about the active llama.cpp model in the pi footer.

## Stats (final scope)

| Stat | Source | Phase shown |
| --- | --- | --- |
| tg3s — generation speed, 3 s sliding window | tapped stream: token-arrival timestamps (`content` + `reasoning_content` deltas) | generating |
| pf3s — prefill speed, 3 s sliding window + progress bar | tapped stream: `prompt_progress` events (server `time_ms`) | prefill |
| KV-cache reuse — `cache/(cache+processed)` | tapped stream: live `cache` field on `prompt_progress` | prefill |
| draft — per-turn spec-decoding figures (`<ratio>% <meanLen>x`, or `not supported`, or `-`) | final SSE chunk's per-turn `timings` (`draft_n`, `draft_n_accepted`): ratio = accepted/draftN, meanLen = 1 + accepted/(predicted_n − accepted); computed at turn end, persistent in every phase until the next turn end or model change | all phases (model-level persistent state) |
| turn's final speeds | final SSE chunk's server `timings`, recorded as the turn's last window sample (cross-check, not a separate display) | end of turn |

Deliberately excluded: session token-usage/cost (another extension owns it), any new display figure derived from `timings` (cross-check only), RAM/VRAM (not exposed).

### Footer format (uniform six-field line)

- The line is always exactly six fields in fixed order — `model · status · pf … · tg3s … · cache … · draft …` — in every phase; a metric that is not actively updating shows `-` (no per-phase line shapes).
- Status vocabulary: `idle`, `active` (a tapped turn mid-turn: prefill or generating), `loading`, `unloaded`, `offline` (unknown values such as `failed`/`sleeping` pass through as the raw word).
- Field value windows: `pf` carries speed + 6-segment progress bar + processed % (prefill only); `tg3s` the generation speed (generating only); `cache` the KV-reuse % (prefill only, `-` until prompt tokens are observed); `draft` the model-level persistent draft state (last computed per-turn figures, `not supported`, or `-` before the first verdict) — the declared exception to the live-value rule, same value in every phase.
- `separator` setting: the literal string joining the fields. Precedence: project `<cwd>/.pi/settings.json` (trusted projects only) > global `<getAgentDir()>/settings.json` > default `" · "`. Accepted only as a non-empty string (invalid type, empty string, or unreadable/corrupt file → default); read once per `session_start`, no mid-session reload. `renderLine(model, view, sep)` in `stats.ts` stays pi-free (the separator is a plain parameter).

## Design

- **Where**: publishable pi package at the repo root (same layout as `gsanhueza/pi-llama-cpp`):
  - `package.json` — pi manifest: `pi.extensions: ["./src/index.ts"]`, `pi-package` keyword; installed via `pi install git:github.com/Faszakasza/llama-status-extension`.
  - `src/index.ts` — pi wiring: active-model resolution, fetch tap, lifecycle poll, status line.
  - `src/stats.ts` — pure logic (window math, SSE chunk parsing, latest-wins stream tracking, draft state machine, rendering). Zero pi imports.
  - `tests/stats.test.ts` + `tests/tap.test.ts` — assert-based checks, `npm test` (jiti dev-only runner; this node build lacks `--experimental-strip-types`). `tests/live.ts` is a manual live run against the router.
  - Local dev: `pi install -l --approve .` registers the repo root as a project package (`.pi/settings.json`, gitignored).
- **Active model**: `ctx.model` + `model_select`; provider id form `llama-server=<baseUrl>` (fallback: `ctx.modelRegistry.getProvider(id).baseUrl`).
- **Rendering**: `ctx.ui.setStatus("llama-stats", line)` — coexists with the built-in footer and other extensions.
- **SSE tap** (`src/index.ts`): a `globalThis.fetch` wrapper intercepts `/chat/completions` requests to the current target's base URL only; injects `return_progress: true` + `stream_options.include_usage: true` into string JSON bodies with `stream: true` (non-string or unparseable bodies pass through unmutated — the tap then degrades to status-line-only, never crashes); wraps the response in a pass-through `ReadableStream` that re-emits the original bytes unchanged and parses `data:` lines for stats. Patches chain with other extensions (e.g. pi-llama-cpp-stats) and are restored on `session_shutdown` / non-llama switch.
- **Turn boundary**: stream open (first chunk with an unseen `chatcmpl-…` id) opens a turn; stream end (`[DONE]`, usage chunk, close, cancel, or error) ends it. Concurrency is latest-wins: a new stream supersedes the active one, late events from superseded streams are dropped, and closing a superseded stream does not idle the newest one.
- **Polling (lifecycle only)**: `/v1/models` @ 2 s renders lifecycle states between turns (`· loading` / `· unloaded`, raw word for `failed`/`sleeping`); its render is suppressed while a stream is active, and a failed poll renders `· offline` only when no stream is active (a stream abort is a turn end → idle, not offline). No `/metrics` or `/slots` requests in any phase. Fetch timeouts 3 s.
- **Windows**: one `speed()` over `{t, v}` samples, 3 s, partial while history is shorter, floored at 500 ms of sample span (`MIN_SPAN_MS` — smaller spans return no figure, rendered `0/s`, so a turn-start MTP burst of a few tokens within milliseconds can't divide a small delta by a millisecond span); pf samples carry server `time_ms`, tg samples carry wall-clock arrival time. `onStreamEnd` records the final chunk's `timings` as the turn's last pf sample (total basis: `prompt_n + cache_n`, since `prompt_n` excludes cached tokens) so the window's final figure cross-checks against `timings.prompt_per_second` (`LLAMA_STATS_DEBUG` logs both).
- **Coexistence**: with pi-llama-cpp-stats installed, both `fetch` patches chain (each wraps the previous); both inject the same body flags idempotently; its working-message prefill bar becomes a redundant subset of this footer.

### Verified stream field map (router mode, live)

| Field | Meaning |
| --- | --- |
| chunk `id` | `chatcmpl-…` request id on every chunk — stream correlation |
| `prompt_progress` | `{total, cache, processed, time_ms}` — server-timed prefill progress, ~1.4 Hz |
| final chunk `usage` | token counts (incl. `prompt_tokens_details.cached_tokens`) |
| final chunk `timings` | `{prompt_n, cache_n, prompt_ms, prompt_per_second, predicted_n, predicted_ms, predicted_per_second}` plus `draft_n` / `draft_n_accepted` iff the server's spec counter path ran for the task — the per-turn draft figures |

(`/slots` and `/metrics` are no longer polled at all; the fields they used to supply are superseded by the stream above.)

## Status

- [x] Proposal / specs / design / tasks (openspec change `llama-footer-stats`)
- [x] Pure stats core + tests
- [x] Extension wiring (model resolution, polling, status line)
- [x] Live verification against the aurora router (Coder Qwen3.8-27B: tg 37–53 t/s, idle transitions, clear on non-llama; Chat Qwen3.6-35B-A3B: full prefill→generating→idle cycle, spec 7.0x when counters advanced)
- [x] Model-lifecycle gating: `/v1/models` status poll gates slot/metrics polling; verified live Chat model `· unloaded → · loading → prefill → idle` and that `/slots` returns 500 for a non-loaded model
- [x] Docs + validate + commit (this file)
- [x] Packaged as a pi package (repo-root `package.json` + `src/` layout, matching `pi-llama-cpp`); `pi config -l` shows `.. → [x] src/index.ts`
- [x] SSE tap (openspec change `sse-tap-stats`): in-turn stats from the tapped `/chat/completions` stream; `/slots` polling deleted; `/metrics` gated on stream-generating; latest-wins stream tracking; final `timings` recorded as the turn's last sample; live-verified on aurora (full turn on the Chat model, spec figure when counters advanced, subagent concurrency, mid-turn model switch, lifecycle, non-llama clear, zero `/slots` requests)
- [x] `sse-tap-stats` archived (2026-08-27): delta synced to the main spec (1 added / 7 modified / 1 removed), change moved to `openspec/changes/archive/2026-08-27-sse-tap-stats/`
- [x] Uniform six-field footer (openspec change `always-visible-footer-fields`): every phase renders `model · status · pf · tg3s · cache · draft` with `-` for non-updating metrics; `active` covers prefill + generating; `separator` setting (project trusted > global > default `" · "`, once per session); live-verified on aurora (full prefill→generating→idle turn, non-llama clear, zero `/slots`)

## Known limitations

- Speeds are client-side windows (server exposes no per-window figures); the window's final sample is seeded from the final chunk's server `timings`, so it cross-checks against `timings.prompt_per_second`/`predicted_per_second` (`LLAMA_STATS_DEBUG` logs the pf comparison).
- Draft support is detected empirically from the per-turn fields, not from spec-type names: ngram-only spec decode never runs the server's spec-counter path (verified: `ngram-map-k4v`/`ngram-mod` turns emit no `draft_n`/`draft_n_accepted`), so such models land on `not supported` after their first completed turn; any turn that reports stats replaces the verdict (self-healing). The verdict is delayed until the first completed generating turn; `draft -` shows meanwhile.
- The tap targets the string JSON body pi sends to `/chat/completions` today; a non-string body skips the flag injection and the extension degrades to the lifecycle line (no crash).
- No API-key support (ponytail comment in `index.ts`); add `readStoredCredential(model.provider)` if a keyed server appears.
