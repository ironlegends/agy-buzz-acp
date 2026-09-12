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

## Release status and succession

| Version | Status | Operational meaning |
| --- | --- | --- |
| 0.5.8 | Public release | The published release documented below. |
| 0.5.9 | Superseded draft | Already installed in some environments; preserve its archive and exact checksum for rollback history. |
| 0.5.10 | Draft candidate, unpublished | Do not deploy to production or describe as released until the real Buzz validation and publication gates pass; an explicitly authorized isolated canary may use it for validation. |

The 0.5.10 candidate is based on source commit `8e9886c836b5c96fb0347027327c334237fa4a4a`, with the same tree as commit `5e24970`. The initial candidate archive used for these checks had SHA-256 `dc53db97ce8bb1ad61aa985afec10ec72a99d47cc22a0731f28398ec65418750`; for a later documentation-only rebuild, use the current archive checksum in the release notes because this hash identifies the tested initial candidate. Candidate checks recorded 457 tests: 453 passed, 0 failed and 4 skipped; CI runs [34709072710](https://github.com/ironlegends/agy-buzz-acp/actions/runs/34709072710) and [34709074250](https://github.com/ironlegends/agy-buzz-acp/actions/runs/34709074250) each completed 9/9. These are source, package and CI checks; they do not by themselves constitute live 0.5.10 Buzz validation.

An authorized provider proof on 2026-09-12T17:59:28Z with agy 1.2.2 passed two synthetic turns: a new provider resumed the same conversation, close was confirmed before synthetic publication, and both turns reached `ready` checkpoints. This establishes provider lifecycle and conversation continuity for the candidate. It does not prove a real Buzz relay round trip or installed Activity Log rendering. The remaining Buzz gate requires the injected agent identity, relay readback and installed UI inspection; a local `buzz users get` probe exited 3 because `BUZZ_PRIVATE_KEY` was required, and no secret was read or extracted.

No deployment or publication occurred during this validation. The 0.5.9 release notice/readback retains its draft target asset IDs, digests and timestamps with title `Superseded`; ten observed processes remained on 0.5.9.

Preserve the 0.5.9 archive and checksum separately from the 0.5.10 candidate. The versions remain distinct because 0.5.9 is already installed in some environments; never rewrite its rollback artifact or silently replace it.

## Released 0.5.8 evidence

Release [v0.5.8](https://github.com/ironlegends/agy-buzz-acp/releases/tag/v0.5.8), source `ebd02c5199f6288d0096f32976e039c7c6f0b7b7`; archive SHA-256 `38bcb4f5d47f965eeec63187ebc86b470300579bc96619fbe351e0d750ac0b4a`.

The final source/clean-worktree checks recorded 300 tests, 299 local Windows passes and one symlink-privilege skip, with no failure. All nine Node 20/22/24 by Windows/Linux/macOS CI cells passed on the implementation and promotion heads, including extracted-package checks. The final extracted package passed six fault scenarios. Twelve repeated confirmed-steering probes passed after the Windows rename fix.

Separate genuine Google/Gemini tests completed normal and resumed turns, then masked a steering confirmation and held a terminal result to exercise the unchanged watchdog and same-process recovery. Those tests used a synthetic publisher. A separate authorized Desktop/relay check on 2026-09-11 observed all ten instances announcing 0.5.8, a sent reply independently received by Desktop, and a ready checkpoint at 15:47:33 UTC. This is not a visually inspected Activity Log, an OS-universal provider check or an exactly-once guarantee.

## Version 0.5.10 lifecycle hardening contract

The lifecycle contract is conservative at the process boundary. A blocked state found by a fresh adapter parent is unknown: the adapter preserves the state and steering bridge, refuses reconciliation before steering archival, and performs no provider or publication work. Same-parent reconciliation requires observed retirement of that parent's direct provider, or a no-start proof tied to a block that the same parent wrote before starting a provider. Native lock ownership and the absence of a child process do not replace that proof.

ACP channel transfer is one-shot and memory-authorized. The previous session must have completed provider retirement, a durably `sent` publication and a `ready` checkpoint. The new session rereads that ready record and binds the exact saved conversation; the old session ID is then permanently invalid for the channel. Concurrent new sessions are serialized, and a missing or blocked ready checkpoint keeps the existing owner in place. A validated ready record remains accepted after restart.

The ACP context parser supplies channel authority only. A thread root or fallback `--reply-to` value remains the publication destination, while `replyTo` never creates a second lifecycle scope. The resumed provider receives the exact trusted conversation association plus the ACP session's configured model and system instructions. These checks establish adapter-side binding and lifecycle ownership; they do not establish provider isolation beyond the capabilities actually exposed by the runtime.

## Historical baseline

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
8. After the real Buzz validation and all preceding checks pass, publish the repository and archive with accurate compatibility limitations. Registry publication is a separate distribution option.

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
