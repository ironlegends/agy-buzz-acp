# Audit hardening candidate

The 2026-10-15 audit produced eight reproduced correctness defects. The candidate groups their fixes and compatibility work in one reviewable PR. It is not a deployment or a published release.

| Finding | Behavior protected | Tracking |
| --- | --- | --- |
| F01 | A channel UUID has one canonical ownership, routing, checkpoint and steering identity, regardless of letter case. Legacy stores require explicit migration. | [#25](https://github.com/ironlegends/agy-buzz-acp/issues/25) |
| F02 | Complete unresolved-delivery scans work beyond 1000 historical records; a later unresolved or invalid record cannot be hidden by pagination. | [#26](https://github.com/ironlegends/agy-buzz-acp/issues/26) |
| F03 | Closing or cancelling during provider rotation prevents a replacement child or stale resume timer. | [#23](https://github.com/ironlegends/agy-buzz-acp/issues/23) |
| F04 | The selected terminal response obeys its UTF-8 byte limit, including after streamed deltas. | [#23](https://github.com/ironlegends/agy-buzz-acp/issues/23) |
| F05 | A successful capability probe cannot erase another required probe's failure. | [#24](https://github.com/ironlegends/agy-buzz-acp/issues/24) |
| F06 | Offline harness readiness requires accessible regular Node and adapter files. | [#24](https://github.com/ironlegends/agy-buzz-acp/issues/24) |
| F07 | Manager diagnostics recognize legitimate interruption before and immediately after a claim, preserving digest association. | [#24](https://github.com/ironlegends/agy-buzz-acp/issues/24) |
| F08 | Fallback activity duration measures the current prompt, excluding reused-child idle time; valid provider duration takes precedence. | [#23](https://github.com/ironlegends/agy-buzz-acp/issues/23) |

Shutdown now has an overall wait bound. An unconfirmed provider close retains ownership and reports failure; sending a kill signal does not establish provider exit. The adapter does not claim arbitrary descendant cleanup or exactly-once external effects.

## Upgrade resistance

The [compatibility manifest](compatibility-manifest.json) separates fixture, extracted-package, real-provider and installed-Desktop evidence. Required CI covers maintained Node 22/24 on Windows, macOS and Linux; Node 26 is an exploratory lane. The package lock and bundled dependency list describe the extracted runtime, including native locking, rather than relying on dependencies installed elsewhere on a developer machine.

Before adopting a provider update, run the fixture suite and extracted smoke, then run the explicit isolated probes with an authenticated provider:

```sh
node scripts/provider-timeout-probe.mjs --command /absolute/path/to/agy
node scripts/provider-canary.mjs --command /absolute/path/to/agy --turns
```

The timeout probe holds stdin open without sending a prompt and observes a two-second print timeout for eight seconds. It reports whether explicit termination was needed; that observation alone does not prove timeout behavior during an active turn. The turn canary runs sandboxed normal/resumed/cancelled ACP work with a fake publisher and fresh private state. It requires no Buzz identity and cannot establish relay delivery. Both scripts verify that the provider binary's SHA-256 remains unchanged during the check. The turn canary makes authenticated provider requests and may consume provider quota. It does not configure a steering hook. Validate enabled steering separately against a dedicated hook before claiming support for a changed provider.

Refresh the manifest with the exact versions and evidence level after validation. Do not infer future compatibility from a successful model listing, or infer that a running adapter loaded new code from a configured path. Installation into Buzz Desktop and a real relay round trip require their own explicit operational validation before release.

## Cleanup decisions

The local import graph contained no unreachable whole runtime module. Historical parser formats, configuration aliases and directory-lock refusal remain compatibility behavior. The unused validation parameter and obsolete return comment were removed or corrected. The CLI now uses the existing setup-help function and shared default-model constant. Public compatibility helpers remain available; lack of a local caller does not prove an external API is unused. No speculative module deletion or broad refactor is part of this candidate.

See [upgrading and rollback](UPGRADING.md), [canonical state migration](STATE_MIGRATION.md), and [outbox archival](OUTBOX_COMPATIBILITY.md) before changing an existing installation. No live store is migrated by the development or CI tests.
