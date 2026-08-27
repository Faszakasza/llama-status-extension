## ADDED Requirements

### Requirement: Concurrent stream handling

When more than one chat-completion stream to the tapped model is open, the extension SHALL display stats for the most recently started stream only (latest-wins), and late events from superseded streams SHALL NOT update the displayed stats or the window history.

#### Scenario: subagent turn starts while main turn runs

- **WHEN** a second stream to the same model opens while a first is active
- **THEN** the footer shows the second stream's stats, and events from the first stream no longer update the display

#### Scenario: superseded stream ends

- **WHEN** the superseded (older) stream closes while the newest stream is still active
- **THEN** the newest stream's stats continue to display (no spurious idle transition)

## MODIFIED Requirements

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

When the active model is loaded and no tapped stream is active, the footer SHALL show the model id and an idle marker, and SHALL NOT show speed or progress values.

#### Scenario: model idle

- **WHEN** the model is loaded and no chat-completion stream to it is currently active
- **THEN** the footer shows `<model id> · idle` (no speed, bar, or acceptance figures)

### Requirement: Prefill phase display

While a tapped stream has received prompt-progress events and has not yet produced a generated token, the footer SHALL show the prefill speed, a prefill progress bar, and the KV-cache reuse ratio, derived from the stream's progress events (processed/total, live cache count, server time).

#### Scenario: prefill in progress

- **WHEN** a tapped stream is sending prompt-progress events with `processed < total` and no generated token has arrived
- **THEN** the footer shows the prefill speed in tokens/s, a progress bar for processed/total prompt tokens, and the cache reuse percentage from the event's cache count

#### Scenario: fully cached prompt

- **WHEN** a prompt was fully served from the KV cache (progress events report `cache == total` and near-zero `processed`)
- **THEN** the cache reuse percentage shows 100% and the prefill speed reflects only the newly processed tokens

### Requirement: Generation phase display

While a tapped stream has produced at least one generated token, the footer SHALL show the generation speed and, when speculative decoding is active on the server, the spec acceptance figure. A generated token is any non-empty `delta.content` **or** `delta.reasoning_content` (thinking models such as Qwen3 stream their output as `reasoning_content`, and it is the dominant share of generation).

#### Scenario: generation in progress

- **WHEN** a tapped stream has produced at least one generated token (content or reasoning) and is still open
- **THEN** the footer shows the generation speed in tokens/s (3-second window over token arrivals)

#### Scenario: spec acceptance shown while generating

- **WHEN** generation is in progress and the server reports speculative-decoding activity (draft tokens and accepted tokens both increased since the last metrics sample)
- **THEN** the footer shows spec acceptance as accepted-tokens-per-verification-step plus 1 (e.g. `spec 1.9x`)

#### Scenario: no speculative decoding active

- **WHEN** the server reports no draft-token activity
- **THEN** no spec acceptance figure is shown

#### Scenario: turn end returns to idle

- **WHEN** the tapped stream completes (final chunk with `[DONE]` received)
- **THEN** the footer returns to the idle display and the spec polling gate closes

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

The cache reuse figure SHALL be computed per turn as cached prompt tokens divided by (cached + processed) prompt tokens from the stream's progress events, and SHALL be shown only while the prefill phase of that turn is displayed.

#### Scenario: mostly cached prompt

- **WHEN** a turn's progress events report 300 total prompt tokens of which 270 came from cache
- **THEN** the footer shows `cache 90%` during that turn's prefill phase

#### Scenario: no prompt tokens yet

- **WHEN** cached + processed prompt tokens is 0
- **THEN** no cache percentage is shown

### Requirement: Model lifecycle and unreachable server

The router loads models on demand and unloads them after inactivity. The extension SHALL poll the server's model status (e.g. `/v1/models`) at a fixed low rate and SHALL render the correct lifecycle state rather than misleading `offline` stats while the model is loading or unloaded. The lifecycle line SHALL apply only while no tapped stream is active, and the spec-acceptance metrics poll SHALL run only while a tapped stream is generating.

#### Scenario: model not yet loaded

- **WHEN** the active model's status is not `loaded` (e.g. `unloaded` or `loading`) and no stream is active
- **THEN** the footer shows the model id plus that lifecycle marker (e.g. `· loading`) and no `/metrics` requests are made

#### Scenario: model becomes loaded

- **WHEN** the model status transitions to `loaded` and no stream is active
- **THEN** the footer shows the idle line (the model is ready for the next turn)

#### Scenario: stream active while status poll runs

- **WHEN** a tapped stream is mid-turn and a status poll reports the model as loaded
- **THEN** the footer keeps showing the turn's phase stats (the status line does not overwrite in-turn display)

#### Scenario: metrics only while generating

- **WHEN** the model is loaded but no stream is generating
- **THEN** no `/metrics` requests are made

#### Scenario: server down

- **WHEN** the status poll fails (network error or non-2xx response) and no stream is active
- **THEN** the footer shows `<model id> · offline` instead of stale stats from a previous turn

#### Scenario: recovery

- **WHEN** the next poll succeeds after failures
- **THEN** normal lifecycle/phase display resumes

## REMOVED Requirements

### Requirement: Busiest slot selection

**Reason**: The `/slots` endpoint is no longer polled; a turn's stats come from that turn's own SSE stream, so there is no set of slots to rank.
**Migration**: None needed — with the active model served at `parallel=1` the tap observes exactly the active request; with concurrent requests the latest-wins rule (see "Concurrent stream handling") selects which turn to display.
