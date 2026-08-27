## ADDED Requirements

### Requirement: Draft spec-decoding figures

The `draft` field SHALL display the active model's per-turn speculative-decoding effectiveness, computed when a tapped stream ends and its final chunk's per-turn `timings` report draft tokens generated greater than 0. The two figures SHALL use the server's own per-task log formulas: the **acceptance ratio** is draft tokens accepted divided by draft tokens generated (displayed as a rounded integer percentage), and the **mean acceptance length** is 1 + draft tokens accepted divided by verification steps, where verification steps are derived as generated tokens minus draft tokens accepted (displayed with one decimal and an `x` suffix). The field is model-level persistent state, not a live metric: it SHALL keep showing the last computed value in every phase (idle, prefill, generating, and lifecycle) and SHALL update only when a new value is computed or the active model changes.

Support SHALL be detected empirically from the per-turn fields, never from the names of the server's enabled speculative-decoding types (no allow-list or deny-list): the presence of draft stats in a completed turn is itself the evidence of support. A model that completes a turn which generated at least one token but whose final chunk reports no draft tokens generated SHALL be shown as `not supported` (literal text in the field), persisting until the active model changes. `not supported` SHALL NOT be latched: a later turn that reports draft stats SHALL replace it with the computed value. A turn ending without draft stats on a model that already shows a computed value SHALL leave the value unchanged. The field SHALL be `-` before any turn verdict for the active model and SHALL reset to `-` when the active model changes. A final chunk whose `timings` omit the draft fields entirely (older server build) SHALL be treated as a turn that reports no draft stats, without error.

#### Scenario: turn end computes the figures

- **WHEN** a tapped stream ends and its final chunk's `timings` report 811 draft tokens generated, 349 accepted, and 538 generated tokens
- **THEN** the `draft` field shows `draft 43% 2.9x` (ratio 349/811 = 43%, mean length 1 + 349/189 = 2.85 → 2.9x) and keeps showing it in every subsequent phase until a new value is computed

#### Scenario: value persists through the next turn's prefill and generating phases

- **WHEN** a previous turn computed `draft 43% 2.9x` and a new turn is in its prefill or generating phase
- **THEN** the `draft` field still shows `draft 43% 2.9x` during that new turn, until the new turn's end computes its own value

#### Scenario: new value replaces the old one

- **WHEN** a previous turn computed `draft 43% 2.9x` and the next turn ends reporting 40 draft tokens generated and 33 accepted
- **THEN** the `draft` field shows the next turn's figures (`draft 83% 3.2x`)

#### Scenario: model without emitting draft types is marked not supported

- **WHEN** the active model completes a turn that generated at least one token and its final chunk reports no draft tokens generated, and the field had not yet computed a value for this model
- **THEN** the `draft` field shows `draft not supported` in every phase until the active model changes or a later turn reports draft stats

#### Scenario: not supported self-heals

- **WHEN** the `draft` field shows `not supported` and a later turn's final chunk reports draft tokens generated greater than 0
- **THEN** the field shows that turn's computed value (the `not supported` verdict is not latched)

#### Scenario: later turn without draft stats keeps the last value

- **WHEN** the `draft` field shows a computed value and a later turn's final chunk reports no draft tokens generated
- **THEN** the field keeps the last computed value

#### Scenario: model switch resets the field

- **WHEN** the active model changes from one llama-server model to another
- **THEN** the `draft` field resets to `-` (no state carries over between models)

#### Scenario: older server build without draft fields

- **WHEN** a turn's final chunk `timings` contain no draft fields
- **THEN** the extension treats it as no draft stats for that turn and does not error

#### Scenario: detection is independent of spec-type names

- **WHEN** the server runs any speculative-decoding configuration (current or future spec types, any combination)
- **THEN** the `draft` field's state is determined solely by whether completed turns report draft stats in their final chunks, with no list of spec-type names in the extension

## MODIFIED Requirements

### Requirement: Uniform footer field layout

The footer line SHALL always consist of exactly six fields in this order: model id (unlabeled), status (unlabeled), `pf`, `tg3s`, `cache`, `draft`, joined by the configured field separator, regardless of the agent status. The status field SHALL be exactly one of `idle`, `active`, `loading`, `unloaded`, or `offline`, where `active` covers both the prefill and the generating phase of a tapped turn. The metric fields are: `pf` (prefill speed), `tg3s` (generation speed), `cache` (KV-cache reuse), `draft` (spec-decoding figures). `pf`, `tg3s`, and `cache` SHALL each show their live value only while that metric is actively updating and SHALL show `-` while it is not. The `draft` field is the exception to this live-value rule: it is model-level persistent state (the last computed per-turn draft figures, or `not supported`, or `-` before the first verdict) and SHALL show the same value in every phase of the active model, updating only when a new per-turn value is computed or the active model changes. The prefill progress bar (processed/total) SHALL remain part of the `pf` field and SHALL be shown only while prefilling.

#### Scenario: idle line shows all fields

- **WHEN** the model is loaded and no tapped stream is active
- **THEN** the footer line is `<model> · idle · pf - · tg3s - · cache - · draft <draft state>` (with the configured separator in place of `·`), where `<draft state>` is `-` before the first verdict, the last computed value, or `not supported`

#### Scenario: prefill line shows all fields

- **WHEN** a tapped stream is mid-prefill
- **THEN** the footer line is `<model> · active · pf <speed> <bar> <processed>% · tg3s - · cache <pct>% · draft <draft state>`

#### Scenario: generating line shows all fields

- **WHEN** a tapped stream is generating
- **THEN** the footer line is `<model> · active · pf - · tg3s <speed> · cache - · draft <draft state>`

#### Scenario: non-updating metric shows a dash

- **WHEN** `pf`, `tg3s`, or `cache` is not actively updating (e.g. `tg3s` while prefill is running, `pf` while generating)
- **THEN** that field shows `-` instead of a value or a stale value

### Requirement: Idle phase display

When the active model is loaded and no tapped stream is active, the status field SHALL be `idle` and the `pf`, `tg3s`, and `cache` fields SHALL show `-`. The `draft` field SHALL show the model's current draft state (per the Draft spec-decoding figures requirement).

#### Scenario: model idle

- **WHEN** the model is loaded and no chat-completion stream to it is currently active
- **THEN** the footer shows `<model> · idle · pf - · tg3s - · cache - · draft <draft state>` (no speed or progress values in `pf`/`tg3s`/`cache`)

### Requirement: Prefill phase display

While a tapped stream has received prompt-progress events and has not yet produced a generated token, the status field SHALL be `active`, the `pf` field SHALL show the prefill speed, a prefill progress bar, and the processed percentage derived from the stream's progress events, and the `cache` field SHALL show the KV-cache reuse ratio (or `-` when no prompt tokens have been observed yet). The `tg3s` field SHALL show `-`, and the `draft` field SHALL show the model's current draft state (per the Draft spec-decoding figures requirement).

#### Scenario: prefill in progress

- **WHEN** a tapped stream is sending prompt-progress events with `processed < total` and no generated token has arrived
- **THEN** the footer shows `<model> · active · pf <speed> <bar> <processed>% · tg3s - · cache <pct>% · draft <draft state>` (speed and bar from the progress events, cache from the event's cache count)

#### Scenario: fully cached prompt

- **WHEN** a prompt was fully served from the KV cache (progress events report `cache == total` and near-zero `processed`)
- **THEN** the `cache` field shows 100%, the bar is nearly empty, and the `pf` speed reflects only the newly processed tokens

### Requirement: Generation phase display

While a tapped stream has produced at least one generated token, the status field SHALL be `active`, the `tg3s` field SHALL show the generation speed, and the `pf` and `cache` fields SHALL show `-`. The `draft` field SHALL show the model's current draft state: the last computed per-turn draft figures persist through the whole turn and are replaced when the turn's end computes a new value (per the Draft spec-decoding figures requirement). A generated token is any non-empty `delta.content` **or** `delta.reasoning_content` (thinking models such as Qwen3 stream their output as `reasoning_content`, and it is the dominant share of generation).

#### Scenario: generation in progress

- **WHEN** a tapped stream has produced at least one generated token (content or reasoning) and is still open
- **THEN** the footer shows `<model> · active · pf - · tg3s <speed> · cache - · draft <draft state>` (speed is the 3-second window over token arrivals; `<draft state>` is the model's current draft state)

#### Scenario: last value persists during a new turn

- **WHEN** a previous turn computed draft figures and the current turn is generating
- **THEN** the `draft` field shows the previous turn's figures until this turn's end computes new ones

#### Scenario: spec acceptance shown while generating

- **WHEN** generation is in progress on a model that uses speculative decoding
- **THEN** the `draft` field shows the model's current draft state (the last computed per-turn figures, which persist through the turn) and is replaced when this turn's end computes new ones

#### Scenario: no speculative decoding active

- **WHEN** the model has no draft verdict yet, or has completed turns that report no draft stats
- **THEN** the `draft` field shows `-` (before the first verdict) or `not supported` (per the Draft spec-decoding figures requirement) — no in-turn spec figure is computed

#### Scenario: turn end returns to idle

- **WHEN** the tapped stream completes (final chunk with `[DONE]` received)
- **THEN** the footer returns to the idle line (status `idle`, `pf`/`tg3s`/`cache` are `-`), with the `draft` field showing the model's current draft state — updated if this turn's end computed a new value

### Requirement: Three-second sliding window speeds

`tg3s` and `pf3s` SHALL be computed as tokens divided by elapsed time over at most the last 3 seconds (partial window while history is shorter than 3 s): `pf3s` from the stream's prompt-progress events using the server's event timestamps, and `tg3s` from token-arrival timestamps. A speed figure SHALL NOT be displayed while the window's sample span is less than 500 ms (the field shows `0/s`), so that a short burst — e.g. 2-4 speculative-decoding tokens arriving within a few milliseconds at a turn's start — cannot divide a small token delta by a millisecond span. The server's per-turn `timings` in the final chunk SHALL be recorded as the turn's last sample (not as a separate display path), so the windowed figure can be cross-checked against the server-computed value. Since `timings.prompt_n` covers only computed (non-cached) tokens while progress `processed` counts cached+new, the last sample SHALL use the total basis (`prompt_n + cache_n`).

#### Scenario: steady generation

- **WHEN** 40 tokens arrived over the last 2 s of the stream
- **THEN** the displayed generation speed is 20 t/s

#### Scenario: first 3 seconds of a turn

- **WHEN** a turn started less than 3 s ago and only a partial window of events exists
- **THEN** the displayed speed is the average over the elapsed partial window once the sample span reaches 500 ms, and `0/s` before that

#### Scenario: turn-start burst does not spike

- **WHEN** a turn starts with 4 speculative tokens arriving within 2 ms followed by steady generation at ~15 t/s
- **THEN** the displayed generation speed is never computed over a span under 500 ms (no millisecond-span spikes such as 1000 t/s at the turn's start)

#### Scenario: window tracks server timings

- **WHEN** the stream's final chunk reports a per-turn `timings` figure (e.g. `prompt_per_second`)
- **THEN** the window's final prefill figure for that turn is within a small margin of the server value (verification cross-check; the displayed format is unchanged)

### Requirement: Model lifecycle and unreachable server

The router loads models on demand and unloads them after inactivity. The extension SHALL poll the server's model status (e.g. `/v1/models`) at a fixed low rate and SHALL render the correct lifecycle state rather than misleading `offline` stats while the model is loading or unloaded. The extension SHALL make no other requests to the server — no `/metrics` and no `/slots` requests in any phase or model state. The lifecycle line SHALL apply only while no tapped stream is active. Every lifecycle line (`loading`, `unloaded`, `offline`) SHALL show the full six-field line with the lifecycle state in the status field, `-` in the `pf`, `tg3s`, and `cache` fields, and the model's current draft state in the `draft` field.

#### Scenario: model not yet loaded

- **WHEN** the active model's status is not `loaded` (e.g. `unloaded` or `loading`) and no stream is active
- **THEN** the footer shows `<model> · <lifecycle status> · pf - · tg3s - · cache - · draft <draft state>` (status `loading` or `unloaded`) and no other server requests are made

#### Scenario: model becomes loaded

- **WHEN** the model status transitions to `loaded` and no stream is active
- **THEN** the footer shows the idle line

#### Scenario: stream active while status poll runs

- **WHEN** a tapped stream is mid-turn and a status poll reports the model as loaded
- **THEN** the footer keeps showing the turn's phase fields (the status line does not overwrite in-turn display)

#### Scenario: no metrics or slots requests

- **WHEN** the extension is active for a llama-server model in any phase (idle, prefill, generating) and in any lifecycle state
- **THEN** the extension makes no `/metrics` or `/slots` requests (only the lifecycle status poll and the tapped chat-completion streams)

#### Scenario: metrics only while generating

- **WHEN** the extension is active in any phase (idle, prefill, generating) or in any lifecycle state
- **THEN** no `/metrics` requests are made at all — the previously generating-only metrics poll is removed, and the lifecycle status poll is the only poll

#### Scenario: server down

- **WHEN** the status poll fails (network error or non-2xx response) and no stream is active
- **THEN** the footer shows `<model> · offline · pf - · tg3s - · cache - · draft <draft state>` instead of stale stats from a previous turn

#### Scenario: recovery

- **WHEN** the next poll succeeds after failures
- **THEN** normal lifecycle/phase display resumes
