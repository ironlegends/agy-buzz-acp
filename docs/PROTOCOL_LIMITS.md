# Protocol limits

The ACP transport (Buzz to `agy-buzz-acp`) and the provider transport
(`agy-buzz-acp` to `agy`) are both newline-delimited JSON over a pipe. Neither
side is trusted to send well-formed, bounded, or complete data, so both are
decoded with the same bounded incremental decoder (`src/frame-codec.js`)
instead of unbounded string concatenation.

## What is bounded

- **Per-line size.** Each NDJSON line (an ACP request or a provider stream
  event) is capped at **8 MiB** by default. A line that exceeds the cap does
  not grow an unbounded in-memory buffer: bytes beyond the cap are discarded
  as they arrive, and the whole line is reported as a single controlled error
  as soon as the limit is crossed. The remainder is discarded until the
  terminating newline so the next frame can be decoded safely.
- **Fragmented UTF-8.** A multi-byte UTF-8 character split across two `data`
  chunks decodes correctly: raw bytes are accumulated for the current line
  and decoded as UTF-8 only once, when the line is complete.
- **Truncated EOF.** If the stream ends with a partial, non-newline-terminated
  line, that is reported as a distinct controlled truncation rather than
  being silently dropped or causing the reader to hang waiting for more data.
- **Empty lines.** A blank line (two consecutive newlines, or a line that is
  only whitespace) is not an error; it decodes to an empty string and callers
  skip it, matching prior behavior.
- **Response accumulation.** The text a provider streams back for a single
  turn (`agy-session.js`, `pending.emittedText` / `pending.segments`) is
  tracked against a byte budget capped at **8 MiB** by default. Exceeding it
  fails the turn with a controlled error instead of growing the accumulated
  response without bound.
- **Deferred provider events.** Events the session must hold until steering
  binding or user-input observation completes (`pending.deferredEvents`) are
  capped at **1024** entries and **8 MiB** of cumulative serialized bytes by
  default. Exceeding either cap fails the turn with a controlled error instead
  of an unbounded queue.
- **Steering hook stdin.** `bin/agy-buzz-steer-hook.js` reads its JSON
  payload from stdin up to **8 MiB** by default; beyond that it treats the
  input as invalid (the same outcome as a JSON parse failure) rather than
  buffering an unbounded amount of untrusted input. UTF-8 is decoded once
  after all chunks arrive with fatal validation.

## Malformed request/event shapes

Before any field is dereferenced, both the ACP request decoder
(`src/acp-server.js`) and the provider event decoder (`src/agy-session.js`)
reject:

- a decoded value that is `null`, an array, or a scalar (string/number/
  boolean) instead of an object;
- (ACP only) a request `id` that is present but is not a string, finite number,
  or `null` — such a request is rejected with `id: null` in the response,
  since the untrusted id itself cannot be trusted to echo back;
- (provider only) an event object whose `event` field is missing or not a
  string.

A malformed ACP request produces a standard JSON-RPC `-32600` (invalid
request) or `-32602` (invalid params) error, including when a malformed method
has no `id`. A malformed provider event fails the current turn with a
controlled error and stops the provider child process; it never throws past
the stream handler.

## Notifications

A valid JSON-RPC request with no `id` field is a notification: it is still
processed (state changes, e.g. `initialize`, still take effect), but no
response is ever written for it, including on application failure. A
structurally malformed request without an `id` receives the invalid-request
error because it is not a valid notification.

## Configuring limits

All of the above defaults are exported from `src/frame-codec.js`
(`DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_DEFERRED_EVENTS`) and can be
overridden with smaller values for tests. Configured limits are normalized to
positive safe integers and capped at the defaults:

- `createAcpServer({ frameLimits: { maxFrameBytes } })` bounds the ACP input
  line size and is threaded through to the default session factory as the
  provider's own `frameLimits`.
- `new AgySession({ frameLimits: { maxFrameBytes, maxResponseBytes,
  maxDeferredEvents, maxDeferredBytes } })` bounds the provider stream line
  size, the accumulated response size, and the deferred-event count and byte
  budgets independently.
- `AGY_STEER_HOOK_MAX_STDIN_BYTES` (environment variable) bounds
  `bin/agy-buzz-steer-hook.js` stdin reading for tests that need a smaller
  cap than the 8 MiB default.
- Runtime and Doctor read `AGY_STEER_HOOK_CONFIGURED` and
  `AGY_STEER_INJECTOR_EXCLUSIVE` through the same explicit boolean parser;
  only `true`, `'true'`, and `'1'` enable a flag.

No raw request, response, or event content is ever written to diagnostics;
only structural details (byte counts, error codes) are logged.
