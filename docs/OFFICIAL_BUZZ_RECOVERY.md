---
title: "Official Buzz recovery and steering"
tags: [recovery, steering, native-lock, buzz]
status: active
created: 2026-09-08
---

# Recovery with official Buzz

This adapter is designed to run behind official Buzz binaries through custom harness configuration. It must not require an ACP sidecar patch or a modified Desktop application.

## Recovery contract

Native OS file locks protect concurrent access. A lock file can remain on disk after release: its existence is not evidence of an active owner. Offline doctor reports native lock files without attempting to acquire them. Never delete them to force a retry.

The separate ready/blocked record controls whether a conversation can resume. Before external work, the record becomes blocked. It becomes ready only after acknowledged delivery, a confirmed provider conversation and provider retirement. With durable state enabled, the provider starts again for each subsequent turn and must confirm the saved conversation before receiving the new prompt. This adds startup latency while avoiding an idle provider behind a ready checkpoint.

A failed or uncertain started turn leaves the record blocked. With durable state enabled every prompt re-reads the record, but disk repair alone is insufficient: in-memory provider liveness, pending operations and the needsReplacement flag still guard recovery. The previous provider must be confirmed closed before the failed AgySession is replaced. Without durable state there is nothing to re-read, so the session stays blocked in memory until the adapter restarts. The same rule applies to the steering bridge, which is inspected on disk on every prompt. Restarting cannot turn incomplete work into completed work. An uncertain message or external tool action is not automatically replayed. Publication and local persistence are not one transaction; exactly-once external execution is not promised.

Provider retirement proves exit of the direct provider. It does not roll back background tools or external effects. A blocked record requires reconciliation before a conversation is reused, and the adapter reconciles it automatically on the next prompt only once the turn that wrote the block has fully settled. The adapter must hold the session ownership lock, no turn may still be running on that channel, and the outbox must hold no `inflight` or `uncertain` delivery for that channel. For a failed turn in the same process, 0.5.8 also awaits the previous provider close event within a bound BEFORE any disk reconciliation. A null child reference or a successful kill request is not sufficient. It constructs a fresh AgySession, retains the ACP session ID, model and caller system instructions, and rebinds only the validated durable association. An unconfirmed close keeps state blocked. This does not establish that external tools were rolled back or that an archived correction was never consumed. A record that still names a conversation resumes it; a record blocked before any conversation existed is removed so the next turn starts fresh. A blocked steering bridge is renamed to a sibling `-archived-<timestamp>` directory, never deleted, and rebuilt on the same prompt. Each reconciliation writes a diagnostic line naming the channel, the conversation and the archive. Nothing else is repaired automatically: a record whose scope does not match, a bridge bound to another owner or channel, or an unsettled delivery is refused exactly as before.

## Steering hook (opt-in)

Steering is disabled unless all of the following are true:

- the official agy PostInvocation hook is configured to run the packaged `agy-buzz-steer-hook` command;
- `AGY_STEER_HOOK_CONFIGURED=1` is present in the Buzz harness environment;
- `AGY_STEER_INJECTOR_EXCLUSIVE=1` confirms that this is the only steering injector;
- `AGY_STEER_OWNER` or `AGY_SESSION_OWNER` contains the 64-hexadecimal public Buzz identity for the session.

`AGY_STEER_ROOT_DIR` may point to a trusted private local directory. The adapter creates channel-scoped bridge state below that root and validates its Windows ACLs. `AGY_STEER_BRIDGE_DIR` and `AGY_STEER_BINDING` are generated and passed to the hook by the adapter; do not set or edit them manually.

The package installs the hook entry point with the other commands. A reviewed agy plugin must call it through a `PostInvocation` command, for example:

```json
{
  "<plugin-id>": {
    "PostInvocation": [
      {
        "type": "command",
        "command": "node <adapter-root>/bin/agy-buzz-steer-hook.js",
        "timeout": 10
      }
    ]
  }
}
```

Use an absolute `node` and adapter path in a real installation. Install the matching release archive completely so the native dependency is available.

### Activation procedure

Both activation and rollback require an inactive boundary and a saved local checkpoint. Never modify configuration while a turn is running or while a steering claim is in-flight.

1. **Stop the affected agent**: In Buzz Desktop, stop the specific agent and verify that its adapter and provider processes are completely retired. Confirm that no active steering claim is pending.
2. **Save a checkpoint**: Preserve a backup of the existing harness file and active session state for recovery.
3. **Install and enable the plugin**: Install the reviewed dedicated plugin through the official agy plugin flow (deploying to `~/.gemini/config/plugins/<plugin-id>/` without overwriting third-party plugins) and enable it using `agy plugin enable <plugin-id>`.
4. **Update the Buzz harness**: Add the opt-in environment variables to the existing Buzz harness JSON configuration:

```json
{
  "env": {
    "AGY_STEER_HOOK_CONFIGURED": "1",
    "AGY_STEER_INJECTOR_EXCLUSIVE": "1",
    "AGY_STEER_OWNER": "<64-hexadecimal Buzz public identity>",
    "AGY_STEER_ROOT_DIR": "<absolute private local directory>"
  }
}
```

Do not introduce an implicit queue switch: `BUZZ_ACP_MULTIPLE_EVENT_HANDLING` must not be set to `queue`.

5. **Refresh the Desktop catalog**: In Buzz Desktop, navigate to **Settings → Agents → Check again** so that the application reloads the updated harness configuration from disk into memory.
6. **Start the agent**: Start the agent in Buzz Desktop. Verify readiness without auto-replaying past business tasks or external effects.

After the provider binds its conversation, the hook may return one text `userMessage` through `injectSteps` with `terminationBehavior: "force_continue"`. The adapter accepts ACP text blocks up to 16,384 characters, confirms consumption with a later matching provider `user_input`, and publishes only the response segment after the correction. It does not cancel the provider or start a replacement turn.

### Rollback procedure

To roll back steering:

1. **Stop the affected agent**: In Buzz Desktop, stop the agent and confirm process termination. Verify that no turn or steering claim is active. Save a checkpoint.
2. **Disable the plugin**: Run `agy plugin disable <plugin-id>` through the official CLI (or ensure the plugin is disabled in `config.json`). Keep the plugin disabled before reusing the runtime.
3. **Revert the harness**: Remove the `AGY_STEER_HOOK_CONFIGURED` and `AGY_STEER_INJECTOR_EXCLUSIVE` flags from the Buzz harness JSON, or restore the saved harness backup.
4. **Refresh the Desktop catalog**: In Buzz Desktop, navigate to **Settings → Agents → Check again** to reload the clean harness into memory.
5. **Start the agent**: Start the agent in Buzz Desktop.

Preserve bridge state and backups for reconciliation; do not delete lock or state files to force a retry. A blocked or uncertain correction remains blocked until its provider and relay effects have been checked.

## Storage and migration

Use a private local state directory. Verify Windows ACLs separately; POSIX modes do not prove Windows privacy. Do not share a live state directory across machines or synchronize it through cloud storage.

Legacy directory locks are refused. An old adapter might still own them. Stop and verify the old runtime before a controlled migration; never use age or PID absence alone as permission to remove a lock.

The tested contract is process termination recovery. Atomic file replacement alone does not establish power-loss durability. Do not claim recovery from arbitrary disk failure or power loss without a separate storage validation.

## Compatibility gates

Validate official Buzz, adapter, Node and agy versions separately. The custom harness schema, ACP negotiation, Buzz context envelope and CLI acknowledgement shape are independent compatibility boundaries. Unknown or contradictory routing must fail before publication. Future Buzz versions are untested until the matrix is extended; no universal forward-compatibility claim is made.

Required release evidence includes the full fixture suite, extracted package including native dependencies, cross-process lock contention and forced termination, ready and blocked records after restart, and real-provider tests on the target OS. A synthetic provider does not prove agy service availability. A successful round trip does not prove crash recovery.

## Version 0.5.3 notes

The 0.5.3 candidate was installed locally behind official Buzz for a bounded Windows integration check. The run confirmed the opt-in hook, a correction injected without cancellation or fallback, a single corrected publication, and a ready state after the completed turn. An agent restart then resumed the same provider conversation and accepted a new explicit probe without replaying the previous work or creating a duplicate publication. The final readback had no uncertain outbox record and no residual provider process.

This evidence is separate from the synthetic fixture suite and does not claim provider availability on every OS, installed UI behavior on every desktop, recovery from a turn interrupted during an external effect, power-loss durability, descendant-process rollback or exactly-once execution for every failure mode. The run did not expose an explicit EOF line, so EOF-specific recovery is not claimed.

Restoring a previously modified sidecar requires an exact version/digest check and a recoverable backup. This document describes the current installation contract and does not perform installation.

## Validation scope for released 0.5.8

The fault matrix starts the actual adapter entry point and its packaged hook as subprocesses, with the real AgySession, native locks, durable state and outbox. Only the provider and publisher endpoints are synthetic. It includes missing/late confirmation, same-process recovery, concurrent work, and uncertain publication. Unit tests separately refuse recovery without a close event. These fixture checks are not live Google/Buzz validation. Separate 0.5.8 genuine-provider fault tests and a Desktop/relay round trip were subsequently recorded; see COMPATIBILITY.md for the evidence levels and release reference. The adapter does not internally replay old input, but Buzz queue retries are a separate source of incoming work and require independent end-to-end review.

## Concurrent recovery and Windows file replacement

Outbox listing is read-only with respect to delivery records, so a recovery scan on one channel cannot overwrite a concurrently completed publication on another. Live `inflight` records remain a recovery guard.

Steering mutations wait at most two seconds for transient native-lock contention before failing closed. Teardown `block()` remains non-waiting. The protected mutation is never retried. On Windows only, an atomic file rename denied with EPERM/EACCES/EBUSY is retried for at most 500 ms; permanent denial remains an error. Only the uncommitted rename is retried, not a provider request, published message, or completed steering transition.
