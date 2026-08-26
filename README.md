# llama-status-extension

Pi agent extension that shows live stats for the **active** llama.cpp / llama-server model in the status footer, while your session runs on it:

```text
Qwen3.6-35B-A3B · pf 547/s ▓▓▓▓▓░ 85% cache 0%   ← prompt processing
Qwen3.6-35B-A3B · tg 40/s spec 7.0x              ← generating (spec decoding)
Qwen3.6-35B-A3B · idle                           ← loaded, waiting
Qwen3.6-35B-A3B · loading / · unloaded / · offline
```

- **tg3s / pf3s**: per-second token counts over a 3 s sliding window (no EMA smoothing), with a 6-segment bar (100% at 1000 t/s).
- **cache**: KV-cache reuse of the current turn (prefill prompt size vs first-time processed tokens).
- **spec**: server-wide spec-decoding acceptance = drafts / (drafts + accepted), shown only while it is advancing.
- Polls the llama-server OpenAI-compatible API (`/v1/models` every 2 s, `/slots` every 500 ms, `/metrics` every 2 s). **Status-gated**: `/slots` + `/metrics` are only fetched while the model is `loaded`, so an unloaded model never shows a misleading `offline`.
- Works in router mode (picks the slot of the active model id) and single-server mode (slot 0).
- No status line while a non-llama model is active. No config; provider URLs come from pi's model config.

## Install

```bash
pi install git:github.com/Faszakasza/llama-status-extension
```

or from a local checkout (project scope):

```bash
pi install -l .
```

## Development

No runtime dependencies; the only import is `@earendil-works/pi-coding-agent` (provided by pi). `jiti` is a dev-only test runner.

```bash
npm test    # assert-based checks for the stats core
node --experimental-strip-types tests/stats.test.ts   # assert-based checks for the stats core
npx tsc -p .                                          # strict type check
```

`src/stats.ts` is the pure logic (windows, slot picking, rendering); `src/index.ts` is the pi wiring (polling, event handlers).
