---
title: "Read-only diagnostics"
tags: [diagnostics, operations, doctor]
status: active
created: 2026-09-07
---

# Read-only diagnostics

`agy-buzz-doctor` checks the local adapter prerequisites without starting a
session, publishing a message, changing a state record, or removing a lock.
The default invocation is offline.

```sh
agy-buzz-doctor
agy-buzz-doctor --json
```

Use `--harness JSON_FILE` with a file containing the JSON printed by `agy-buzz-acp setup` to inspect
the configured Node, adapter, agy and Buzz paths. The report reads the
adapter package version from its package metadata. It reports the running
adapter version as `null` with an `unknown` status unless a separately
verified runtime proof is available; a configured version is not evidence of
the running version. Harness environment values are not echoed. Only the
selected model identifier is included when it passes the normal bounded
identifier format.

Use `--latest` only when an online check is wanted. It performs one bounded
unauthenticated request to the repository's GitHub latest-release endpoint.
No environment dump, credential, or provider output is sent with that
request. Network failure is reported as an uncertain optional check and does
not change the default offline behavior.

Use `--models` only when a provider catalog check is wanted. The doctor runs
the configured agy executable with `models`, `shell: false`, a bounded timeout
and bounded output. It uses the diagnostic process's existing safe runtime
environment and never prints raw provider output. The command does not start
a conversation or publish a message.

When `AGY_OUTBOX_DIR` or `AGY_SESSION_DIR` is configured correctly and the
directory is readable, the report summarizes JSON records as `ready`,
`blocked`, `uncertain` and `invalid` counts. Outbox status categories also
retain the safe names `sent`, `failed-before-start`, `inflight` and
`uncertain`. Session and outbox lock totals are reported separately. Persistent native files are counted as `native-file`; their presence does not prove ownership and Doctor does not acquire them. Only legacy lock directories with PID metadata can be marked stale when that process can be checked. Unknown
lock ownership remains unknown, and a live PID is only reported as
`live-pid`, not proof that the lock is valid. Record contents, recovery IDs,
conversation IDs, owner values, paths and raw filesystem errors are omitted.

The scanner validates complete records using the same session and outbox
record contracts as the runtime. It caps the number of directory entries and
the size of each record file, and refuses symbolic-link roots, records and
locks. Blocked, uncertain, invalid, truncated and stale findings make the
store diagnostic a warning; the scanner never treats them as ready.

An `inflight` record is only counted as `uncertain`; the doctor never transitions it. Outbox list scans are also read-only for delivery records in 0.5.8, whereas explicit get/show paths may classify abandoned inflight work as uncertain. Stale locks are evidence for manual
operator reconciliation. The doctor does not unlock, retry, delete, or
rewrite anything.

## Scope in released 0.5.8

Doctor inspects session/outbox stores, not dedicated steering bridges. Its success does not establish that steering is recoverable or a running provider has stopped. Automatic reconciliation requires both durable session state and an enabled readable outbox, in addition to runtime ownership/liveness checks. Issue #6 tracks the missing steering inspection and guided recovery diagnostics.
