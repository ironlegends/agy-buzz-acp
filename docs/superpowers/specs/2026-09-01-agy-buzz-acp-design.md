---
title: "Original agy Buzz ACP adapter design"
tags: [buzz, acp, antigravity, agy, gemini]
status: superseded
created: 2026-09-01
---

# Original design and retained invariants

This document records the local prototype's design. The current README and release documents supersede old scope restrictions and describe current optional features.

## Provider sessions

One agy process serves each ACP session. Prompts are `user` NDJSON events. The initial system prompt is prefixed only once. Different sessions do not share provider state. The provider runs without a shell, with `--input-format stream-json --output-format stream-json --model gemini-3.8-flash-high --print-timeout 24h --sandbox`.

The print timeout is a process wall-clock limit rather than a per-turn timeout. Buzz's own turn limits are separate. ACP prompt content must not override the model or disable the sandbox.

## Stream and delivery

Text deltas become ACP message chunks. A terminal response supplies the final answer; a successful prompt returns `stopReason: end_turn`. Activity events are separate from that answer.

Only the current prompt's structured Buzz Context block supplies channel and reply destination. Narrative history and system instructions are not routing authorities. Missing, duplicate or contradictory context is rejected before provider or publisher execution.

The final answer is passed to the Buzz CLI through stdin, without a shell. A valid `accepted: true` response with a 64-character hexadecimal event ID establishes `sent`. A publisher that never starts yields `failed-before-start`; ambiguous results yield `uncertain`.

The ACP turn remains active through publication. A second prompt is rejected until it completes. Cancellation interrupts provider and publisher work and never triggers prompt replay.

## Optional delivery storage

Outbox storage is disabled by default. A directory and public owner must be configured together. Records contain final answer, destination, public owner and delivery state, not credentials or prompts. Recovery verifies owner identity and claims the record before publication. Only `failed-before-start` may be retried automatically by an explicit recovery command. Interrupted or uncertain publication remains blocked.

An outbox write failure can retain a memory-only recovery ID in the active adapter; that ID does not survive process exit.

## ACP and sensitive data

The server accepts protocolVersion 1 or 2 and negotiates stable v1 semantics. Text is supported; images, audio, embedded context and transport MCP bridging are not. Provider-local tool policy is configured separately.

The adapter does not read the provider credential store, persist MCP declarations, or relay raw provider diagnostics. It does not grant provider-service authorization. Authentication and applicable service terms remain external to this component.

## Validation

Native Node tests use fake agy and Buzz processes. They cover handshake, session isolation, sandbox arguments, delta/terminal mapping, routing, cancellation, delivery states and recovery. Real-provider probes and installed UI inspection remain separate forms of evidence.
