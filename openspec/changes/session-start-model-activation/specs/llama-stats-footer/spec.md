## MODIFIED Requirements

### Requirement: Footer status line lifecycle

The extension SHALL apply the active model on every `session_start` event, regardless of the session-start reason (fresh startup, session resume or switch, new session, forked session, or reload), because those reasons re-emit the already-set active model without a model-selection event. The extension SHALL display a one-line status in the pi footer while the active model belongs to a `llama-server` provider, and SHALL clear that status (and stop all requests to the server) when the active model is no longer a `llama-server` provider. The extension SHALL tap in-process the chat-completion SSE responses to the active model to derive in-turn stats, and SHALL NOT add requests to the server for in-turn stats beyond the lifecycle status poll. Applying the active model is idempotent: re-applying the same model SHALL NOT leak timers or duplicate stream taps.

#### Scenario: llama-server model active

- **WHEN** the user selects a model whose provider is a `llama-server=<url>` provider
- **THEN** the footer shows a single status line for that model, the extension taps chat-completion streams to that model, and the lifecycle status poll continues

#### Scenario: resumed or replaced session restores the footer

- **WHEN** a session is resumed, replaced by a new or forked session, or the runtime is reloaded, and the active model belongs to a `llama-server` provider
- **THEN** the footer shows the status line for that model and the lifecycle status poll resumes within one poll tick, without requiring a model-selection event

#### Scenario: re-applying the same model does not leak

- **WHEN** `session_start` fires again (for any reason) while the same llama-server model is already active
- **THEN** no additional lifecycle timer or stream tap exists; the previous poll interval and tap are torn down before the new one is installed

#### Scenario: non-llama model selected

- **WHEN** the active model changes to any model whose provider is not a `llama-server` provider
- **THEN** the status line is cleared and no further server requests are made

#### Scenario: model switch resets stats

- **WHEN** the active model changes from one llama-server model to another
- **THEN** all window samples and deltas are reset before new stats are displayed, so no number ever mixes samples from two different models

#### Scenario: tapped response is unmodified for the agent

- **WHEN** the extension taps a chat-completion stream for stats
- **THEN** the agent receives the response bytes unchanged (tap is pass-through), so the stream is functionally identical to an untapped response
