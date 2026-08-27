## Purpose

Shows live llama.cpp server statistics in the pi footer while the active model is served by a llama-server provider, so the user can see generation/prefill speed, prefill progress, KV-cache reuse, and speculative-decoding effectiveness at a glance.

## Requirements

### Requirement: Footer status line lifecycle

The extension SHALL display a one-line status in the pi footer while the active model belongs to a `llama-server` provider, and SHALL clear that status (and stop all requests to the server) when the active model is no longer a `llama-server` provider. The extension SHALL tap in-process the chat-completion SSE responses to the active model to derive in-turn stats, and SHALL NOT add requests to the server for in-turn stats beyond the lifecycle status poll.

#### Scenario: llama-server model active

- **WHEN** the user selects a model whose provider is a `llama-server=<url>` provider
- **THEN** the footer shows a single status line for that model, the extension taps chat-completion streams to that model, and the lifecycle status poll continues

#### Scenario: non-llama model selected

- **WHEN** the active model changes to any model whose provider is not a `llama-server` provider
- **THEN** the status line is cleared and no further server requests are made

#### Scenario: model switch resets stats

- **WHEN** the active model changes from one llama-server model to another
- **THEN** all window samples and deltas are reset before new stats are displayed, so no number ever mixes samples from two different models

#### Scenario: tapped response is unmodified for the agent

- **WHEN** the extension taps a chat-completion stream for stats
- **THEN** the agent receives the response bytes unchanged (tap is pass-through), so the stream is functionally identical to an untapped response

### Requirement: Idle phase display

When the active model is loaded and no tapped stream is active, the status field SHALL be `idle` and all four metric fields (`pf`, `tg3s`, `cache`, `draft`) SHALL show `-` (no speed, bar, or acceptance figures).

#### Scenario: model idle

- **WHEN** the model is loaded and no chat-completion stream to it is currently active
- **THEN** the footer shows `<model> · idle · pf - · tg3s - · cache - · draft -`

### Requirement: Prefill phase display

While a tapped stream has received prompt-progress events and has not yet produced a generated token, the status field SHALL be `active`, the `pf` field SHALL show the prefill speed, a prefill progress bar, and the processed percentage derived from the stream's progress events, and the `cache` field SHALL show the KV-cache reuse ratio (or `-` when no prompt tokens have been observed yet). The `tg3s` and `draft` fields SHALL show `-`.

#### Scenario: prefill in progress

- **WHEN** a tapped stream is sending prompt-progress events with `processed < total` and no generated token has arrived
- **THEN** the footer shows `<model> · active · pf <speed> <bar> <processed>% · tg3s - · cache <pct>% · draft -` (speed and bar from the progress events, cache from the event's cache count)

#### Scenario: fully cached prompt

- **WHEN** a prompt was fully served from the KV cache (progress events report `cache == total` and near-zero `processed`)
- **THEN** the `cache` field shows 100%, the bar is nearly empty, and the `pf` speed reflects only the newly processed tokens

### Requirement: Generation phase display

While a tapped stream has produced at least one generated token, the status field SHALL be `active`, the `tg3s` field SHALL show the generation speed, the `pf` and `cache` fields SHALL show `-`, and the `draft` field SHALL show the spec acceptance figure when the server reports speculative-decoding activity and `-` otherwise. A generated token is any non-empty `delta.content` **or** `delta.reasoning_content` (thinking models such as Qwen3 stream their output as `reasoning_content`, and it is the dominant share of generation).

#### Scenario: generation in progress

- **WHEN** a tapped stream has produced at least one generated token (content or reasoning) and is still open
- **THEN** the footer shows `<model> · active · pf - · tg3s <speed> · cache - · draft -` (speed is the 3-second window over token arrivals)

#### Scenario: spec acceptance shown while generating

- **WHEN** generation is in progress and the server reports speculative-decoding activity (draft tokens and accepted tokens both increased since the last metrics sample)
- **THEN** the `draft` field shows accepted-tokens-per-verification-step plus 1 (e.g. `draft 7.0x`)

#### Scenario: no speculative decoding active

- **WHEN** the server reports no draft-token activity
- **THEN** the `draft` field shows `-`

#### Scenario: turn end returns to idle

- **WHEN** the tapped stream completes (final chunk with `[DONE]` received)
- **THEN** the footer returns to the idle line (status `idle`, all metric fields `-`) and the spec polling gate closes

### Requirement: Concurrent stream handling

When more than one chat-completion stream to the tapped model is open, the extension SHALL display stats for the most recently started stream only (latest-wins), and late events from superseded streams SHALL NOT update the displayed stats or the window history.

#### Scenario: subagent turn starts while main turn runs

- **WHEN** a second stream to the same model opens while a first is active
- **THEN** the footer shows the second stream's stats, and events from the first stream no longer update the display

#### Scenario: superseded stream ends

- **WHEN** the superseded (older) stream closes while the newest stream is still active
- **THEN** the newest stream's stats continue to display (no spurious idle transition)

### Requirement: Three-second sliding window speeds

`tg3s` and `pf3s` SHALL be computed as tokens divided by elapsed time over at most the last 3 seconds (partial window while history is shorter than 3 s): `pf3s` from the stream's prompt-progress events using the server's event timestamps, and `tg3s` from token-arrival timestamps. The server's per-turn `timings` in the final chunk SHALL be recorded as the turn's last sample (not as a separate display path), so the windowed figure can be cross-checked against the server-computed value. Since `timings.prompt_n` covers only computed (non-cached) tokens while progress `processed` counts cached+new, the last sample SHALL use the total basis (`prompt_n + cache_n`).

#### Scenario: steady generation

- **WHEN** 40 tokens arrived over the last 2 s of the stream
- **THEN** the displayed generation speed is 20 t/s

#### Scenario: first 3 seconds of a turn

- **WHEN** a turn started less than 3 s ago and only a partial window of events exists
- **THEN** the displayed speed is the average over the elapsed partial window

#### Scenario: window tracks server timings

- **WHEN** the stream's final chunk reports a per-turn `timings` figure (e.g. `prompt_per_second`)
- **THEN** the window's final prefill figure for that turn is within a small margin of the server value (verification cross-check; the displayed format is unchanged)

### Requirement: KV-cache reuse ratio

The cache reuse figure SHALL be computed per turn as cached prompt tokens divided by (cached + processed) prompt tokens from the stream's progress events, and SHALL be shown in the `cache` field while the prefill phase of that turn is displayed. When cached + processed prompt tokens is 0, or when the prefill phase is not displayed, the `cache` field SHALL show `-`.

#### Scenario: mostly cached prompt

- **WHEN** a turn's progress events report 300 total prompt tokens of which 270 came from cache
- **THEN** the `cache` field shows `cache 90%` during that turn's prefill phase

#### Scenario: no prompt tokens yet

- **WHEN** cached + processed prompt tokens is 0
- **THEN** the `cache` field shows `-`

### Requirement: Model lifecycle and unreachable server

The router loads models on demand and unloads them after inactivity. The extension SHALL poll the server's model status (e.g. `/v1/models`) at a fixed low rate and SHALL render the correct lifecycle state rather than misleading `offline` stats while the model is loading or unloaded. The lifecycle line SHALL apply only while no tapped stream is active, and the spec-acceptance metrics poll SHALL run only while a tapped stream is generating. Every lifecycle line (`loading`, `unloaded`, `offline`) SHALL show the full six-field line with the lifecycle state in the status field and `-` in all four metric fields.

#### Scenario: model not yet loaded

- **WHEN** the active model's status is not `loaded` (e.g. `unloaded` or `loading`) and no stream is active
- **THEN** the footer shows `<model> · <lifecycle status> · pf - · tg3s - · cache - · draft -` (status `loading` or `unloaded`) and no `/metrics` requests are made

#### Scenario: model becomes loaded

- **WHEN** the model status transitions to `loaded` and no stream is active
- **THEN** the footer shows the idle line

#### Scenario: stream active while status poll runs

- **WHEN** a tapped stream is mid-turn and a status poll reports the model as loaded
- **THEN** the footer keeps showing the turn's phase fields (the status line does not overwrite in-turn display)

#### Scenario: metrics only while generating

- **WHEN** the model is loaded but no stream is generating
- **THEN** no `/metrics` requests are made

#### Scenario: server down

- **WHEN** the status poll fails (network error or non-2xx response) and no stream is active
- **THEN** the footer shows `<model> · offline · pf - · tg3s - · cache - · draft -` instead of stale stats from a previous turn

#### Scenario: recovery

- **WHEN** the next poll succeeds after failures
- **THEN** normal lifecycle/phase display resumes

### Requirement: Uniform footer field layout

The footer line SHALL always consist of exactly six fields in this order: model id (unlabeled), status (unlabeled), `pf`, `tg3s`, `cache`, `draft`, joined by the configured field separator, regardless of the agent status. The status field SHALL be exactly one of `idle`, `active`, `loading`, `unloaded`, or `offline`, where `active` covers both the prefill and the generating phase of a tapped turn. The metric fields are: `pf` (prefill speed), `tg3s` (generation speed), `cache` (KV-cache reuse), `draft` (spec-decoding acceptance). Each metric field SHALL show its live value only while that metric is actively updating and SHALL show `-` while it is not. The prefill progress bar (processed/total) SHALL remain part of the `pf` field and SHALL be shown only while prefilling.

#### Scenario: idle line shows all fields

- **WHEN** the model is loaded and no tapped stream is active
- **THEN** the footer line is `<model> · idle · pf - · tg3s - · cache - · draft -` (with the configured separator in place of `·`)

#### Scenario: prefill line shows all fields

- **WHEN** a tapped stream is mid-prefill
- **THEN** the footer line is `<model> · active · pf <speed> <bar> <processed>% · tg3s - · cache <pct>% · draft -`

#### Scenario: generating line shows all fields

- **WHEN** a tapped stream is generating
- **THEN** the footer line is `<model> · active · pf - · tg3s <speed> · cache - · draft <figure or ->`

#### Scenario: non-updating metric shows a dash

- **WHEN** a metric field is not actively updating (e.g. `tg3s` while prefill is running, `pf` while generating)
- **THEN** that field shows `-` instead of a value or a stale value

### Requirement: Configurable field separator

The extension SHALL read an optional `separator` setting from pi's `settings.json` and use its string value verbatim as the separator between the footer's six fields. When the project is trusted, the project `.pi/settings.json` value SHALL take precedence over the global `~/.pi/agent/settings.json` value. When `separator` is not set, the separator SHALL default to the middle dot (`·`) with one space on each side, so the default output matches the previous separator.

#### Scenario: separator configured

- **WHEN** `settings.json` contains `"separator": " | "` and a line is rendered
- **THEN** the fields are joined with ` | ` (e.g. `<model> | idle | pf - | tg3s - | cache - | draft -`)

#### Scenario: project setting wins over global

- **WHEN** the project is trusted, project `settings.json` sets `separator` to one value and the global `settings.json` sets a different one
- **THEN** the project value is used

#### Scenario: not configured

- **WHEN** `separator` is not present in any `settings.json`
- **THEN** the default ` · ` separator is used and the line matches the previous default format

#### Scenario: untrusted project

- **WHEN** the project is not trusted and only the project `settings.json` sets `separator`
- **THEN** the project value is ignored and the global value or the default is used

#### Scenario: invalid value

- **WHEN** `separator` is not a non-empty string (type mismatch, empty string, or an unreadable/corrupt settings file)
- **THEN** the default separator is used and the extension does not crash
