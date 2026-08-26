## Purpose

Shows live llama.cpp server statistics in the pi footer while the active model is served by a llama-server provider, so the user can see generation/prefill speed, prefill progress, KV-cache reuse, and speculative-decoding effectiveness at a glance.

## ADDED Requirements

### Requirement: Footer status line lifecycle

The extension SHALL display a one-line status in the pi footer while the active model belongs to a `llama-server` provider, and SHALL clear that status (and stop all polling) when the active model is no longer a `llama-server` provider.

#### Scenario: llama-server model active

- **WHEN** the user selects a model whose provider is a `llama-server=<url>` provider
- **THEN** the footer shows a single status line for that model and the extension polls the server

#### Scenario: non-llama model selected

- **WHEN** the active model changes to any model whose provider is not a `llama-server` provider
- **THEN** the status line is cleared and no further server requests are made

#### Scenario: model switch resets stats

- **WHEN** the active model changes from one llama-server model to another
- **THEN** all window samples and deltas are reset before new stats are displayed, so no number ever mixes samples from two different models

### Requirement: Idle phase display

When the active model is loaded and no slot is processing, the footer SHALL show the model id and an idle marker, and SHALL NOT show speed or progress values.

#### Scenario: model idle

- **WHEN** polling succeeds and no slot of the active model has `is_processing` true
- **THEN** the footer shows `<model id> · idle` (no speed, bar, or acceptance figures)

### Requirement: Prefill phase display

While a slot is processing and has not yet produced a generated token, the footer SHALL show the prefill speed, a prefill progress bar, and the KV-cache reuse ratio.

#### Scenario: prefill in progress

- **WHEN** the polled slot has `is_processing` true and generated-token count is 0
- **THEN** the footer shows the prefill speed in tokens/s, a progress bar for processed/total prompt tokens, and the cache reuse percentage

#### Scenario: fully cached prompt

- **WHEN** all prompt tokens of a turn were served from the KV cache
- **THEN** the cache reuse percentage is 100% and the processed-token count excludes cached tokens

### Requirement: Generation phase display

While a slot has produced at least one generated token, the footer SHALL show the generation speed and, when speculative decoding is active on the server, the spec acceptance figure.

#### Scenario: generation in progress

- **WHEN** the polled slot has `is_processing` true and generated-token count greater than 0
- **THEN** the footer shows the generation speed in tokens/s (3-second window)

#### Scenario: spec acceptance shown while generating

- **WHEN** generation is in progress and the server reports speculative-decoding activity (draft tokens and accepted tokens both increased since the last metrics sample)
- **THEN** the footer shows spec acceptance as accepted-tokens-per-verification-step plus 1 (e.g. `spec 1.9x`)

#### Scenario: no speculative decoding active

- **WHEN** the server reports no draft-token activity
- **THEN** no spec acceptance figure is shown

### Requirement: Three-second sliding window speeds

`tg3s` and `pf3s` SHALL be computed by the extension from consecutive poll samples as tokens divided by elapsed time over at most the last 3 seconds (partial window while history is shorter than 3 s), refreshed on every poll, and MUST NOT rely on any server-side per-request timing.

#### Scenario: steady generation

- **WHEN** 40 tokens were generated over the last 2 s of polling samples
- **THEN** the displayed generation speed is 20 t/s

#### Scenario: first 3 seconds of a turn

- **WHEN** a turn started less than 3 s ago and only a partial window of samples exists
- **THEN** the displayed speed is the average over the elapsed partial window

### Requirement: KV-cache reuse ratio

The cache reuse figure SHALL be computed per turn as cached prompt tokens divided by (cached + processed) prompt tokens for the current request, and SHALL be shown only while the prefill phase of that turn is displayed.

#### Scenario: mostly cached prompt

- **WHEN** a turn processed 300 prompt tokens of which 270 came from cache
- **THEN** the footer shows `cache 90%` during that turn's prefill phase

#### Scenario: no prompt tokens yet

- **WHEN** cached + processed prompt tokens is 0
- **THEN** no cache percentage is shown

### Requirement: Busiest slot selection

When more than one slot of the active model is processing, the extension SHALL display the stats of the busiest slot (a slot that is generating beats a slot in prefill; ties broken by most tokens in flight).

#### Scenario: two slots busy

- **WHEN** one slot is in prefill and another is generating
- **THEN** the footer shows the generating slot's stats

### Requirement: Unreachable or unloaded model

When the server is unreachable, the active model is not loaded, or the `/slots` query fails, the extension SHALL display a degraded state (model id plus an `offline`/unavailable marker) and SHALL NOT display stale stats from a previous turn.

#### Scenario: server down

- **WHEN** a poll fails (network error or non-2xx response)
- **THEN** the footer shows `<model id> · offline` instead of the last successful stats

#### Scenario: recovery

- **WHEN** the next poll succeeds after failures
- **THEN** normal phase display resumes
