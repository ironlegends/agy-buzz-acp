# Compatibility and release checks

## Evidence levels

| Check | What it establishes |
| --- | --- |
| Node fixture suite on Windows/macOS/Linux | Adapter behavior with synthetic local providers and publishers. |
| Extracted package smoke test | Required runtime files and commands are present in the archive. |
| Real agy, fake publisher | Provider wire format, conversation continuity and lifecycle behavior without external publication. |
| Real Buzz round trip | Answer delivery and relay acknowledgement for the tested installation. |
| Installed Activity Log inspection | Actual UI titles, terminal states, durations and separation from the answer. |

Do not substitute one level for another. In particular, CI on an OS does not prove that an authenticated Antigravity binary is available or supported there.

## Known baseline

Before this release, the Windows adapter passed 96 fixture tests. A real provider conversation resumed after a completed turn and child termination. A Buzz message was published and acknowledged. Activity mapping was exercised through Buzz's source parser, but the installed desktop rendering was not visually inspected.

Those observations describe the earlier build, not automatic proof for a later release. A new release must report its own commit, test count and archive hash.

## Release procedure

1. Run the full fixture suite on each supported CI OS and Node version.
2. Run `npm pack`, inspect the allowlist, and extract the archive into a new directory.
3. Start the extracted ACP command and complete an `initialize` handshake. Run doctor and recovery usage checks.
4. Verify that no machine-specific paths, credentials, test logs or runtime state are included.
5. With a separately authenticated provider, run two synthetic turns and verify safe continuity. Use a fake publisher.
6. In an explicitly authorized Buzz installation, inspect generation, tool and delivery activities and compare the final sent event ID with the relay response.
7. Obtain independent review for lifecycle, persistence and release changes. Record the exact Git SHA and archive SHA-256.
8. Publish the repository and archive with accurate compatibility limitations. Registry publication is a separate distribution option.

## Local data protection

Use an operator-provisioned private local directory for optional persistence. On POSIX, verify owner and mode. On Windows, verify effective ACLs for the Buzz account; chmod-style modes alone are insufficient. Local state is plaintext. Do not synchronize it between machines or identities.

A pending or uncertain operation is a recovery boundary, not evidence that nothing happened. Inspect actual provider/relay state before manual reconciliation. Never delete a lock or record merely to force an automatic retry.

## Shutdown limitation in Buzz

The previous directory-lock implementation required orderly adapter shutdown. Official Buzz can terminate the ACP child without an EOF grace period, leaving those old directory locks behind. Version 0.5.3 uses a native OS lock and does not depend on an EOF grace period or an ACP sidecar patch. Existing directory locks still require controlled migration and are never automatically removed.

Activation requires evidence from official Buzz: a delivered, checkpointed turn must resume the same conversation after restart, while interrupted or uncertain work remains blocked. Native lock release alone is not that evidence. See [recovery with official Buzz](OFFICIAL_BUZZ_RECOVERY.md) for the provider-retirement and validation contract. Provider availability, direct-child exit and arbitrary external tool effects are separate concerns.

## Native steering

The `_session/steering` extension is advertised only when the dedicated PostInvocation hook and the exclusive injector precondition are both explicitly configured with `AGY_STEER_HOOK_CONFIGURED=1` and `AGY_STEER_INJECTOR_EXCLUSIVE=1`, together with a valid `AGY_STEER_OWNER` or `AGY_SESSION_OWNER`. The adapter provisions a private, channel-scoped bridge before the first provider spawn; the provider conversation is bound to that bridge only after its matching `init` event. Claims remain unavailable until that binding, then require the hook acknowledgement and a later matching `user_input` step.

Buzz sends `_session/steering` prompts as ACP arrays of text content blocks. The adapter validates those blocks, concatenates their text within the bounded limit, and rejects other content types.

The adapter publishes the response segment after the last confirmed correction. It never publishes the provider's cumulative `result.response` after steering, never kills the provider to inject a message, and never returns `startedNewTurn` in version 1. A result, provider exit, missing segment, claim timeout, or delivery boundary before consumption makes the steering state blocked; Buzz receives an application error other than `-32601` so its normal dispatch can retain the message for a later decision. A correction cannot be replayed automatically after an ambiguous claim.

## Version 0.5.3 validation note

Version 0.5.3 adds the native lock dependency, the opt-in PostInvocation steering hook, and the corresponding blocked-state protections. The dependency and its native support packages are bundled in the extracted npm archive.

The fixture suite for this candidate recorded 248 tests: 247 passed, one was skipped, and none failed. These tests use synthetic providers and publishers. They do not establish provider availability, account eligibility, official Buzz behavior or installed UI rendering.

A separate Windows run through the official Buzz application exercised the installed 0.5.3 adapter. It confirmed a steering correction delivered without cancellation or the cancel-and-merge fallback, one corrected response, a ready state after completion, and a subsequent agent restart that resumed the same provider conversation without replay or duplicate publication. The readback confirmed completed outbox delivery with no uncertain record.

This real-installation evidence covers a completed-turn restart. It does not prove recovery from an interrupted external effect, arbitrary descendant-process cleanup, power loss or exactly-once execution under every failure mode. The run did not expose an explicit EOF line, so no EOF-specific claim is made.
