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

## Version 0.6.0 candidate baseline (2026-10-15)

### Platform support and evidence

The adapter targets the following desktop environments with Node.js 22 or newer. AGY and Buzz must be installed and authenticated separately. Fixture and extracted-package checks validate adapter behavior without an authenticated provider or real publication.

| Target | Blocking Node 22/24 CI | Installed AGY/Buzz evidence |
| --- | --- | --- |
| Windows x64 | `windows-latest` | Dedicated Windows validation recorded below; a later required Node 22 CI run exposed the separately tracked intermittent ACL-inspection refusal. |
| macOS Apple Silicon | `macos-latest` | Real-provider, relay and Desktop checks remain unverified. |
| macOS Intel | `macos-15-intel` | Explicit architecture coverage added for the portability fix; real-provider, relay and Desktop checks remain unverified. |
| Linux x64 | `ubuntu-latest` | Real-provider, relay and Desktop checks remain unverified. |

Node 26 remains exploratory on the original three OS labels. Native prebuilds exist for Windows/Linux ARM64, but these variants have no dedicated CI or installed-provider proof in this matrix. Linux coverage uses Ubuntu; it does not establish Alpine/musl or every Linux distribution.

macOS may expose its temporary directory through system aliases such as `/var` or `/tmp`. Runtime-owned initialization-lock and default steering directories resolve the existing OS temporary base before appending their own child names. Explicit user-selected state, steering and bridge paths retain the symlink refusals, as do children below the resolved temporary base. Fresh-process regressions set an aliased temporary directory without the fixture environment preload so the tests do not mask this launch configuration.

Version 0.6.0 is an unreleased candidate. The package requires Node.js 22 or newer. The maintained LTS majors, Node 22 and 24, are the blocking CI targets on Ubuntu, Windows and macOS. Node 26 is an exploratory CI target on the same operating systems and does not block the build. CI and fixture results establish adapter behavior for those test environments; they do not establish provider availability or compatibility with a live Buzz installation.

The isolated ACP canary ran on Node.js 24.14.0 on Windows with the installed Antigravity CLI at version 1.3.5. The earlier CLI observation on 2026-10-15 was version 1.3.3; no explicit update command between those observations was recorded. Both model listings returned six verified models. The canary passed ACP initialization, a normal turn, checkpoint resume with the same conversation, and cancellation. It used a fake publisher, producing two fake publications and zero real publications. Observed ACP events included `init`, `result` and `step_update` with `agent_response`, `system_message` and `user_input` content. Steering was not run because the dedicated hook was not configured. This canary does not establish real relay delivery or installation in Buzz Desktop.

Buzz Desktop was updated from file version 0.5.26 to 0.5.28 through its official updater, after preserving the binaries and configuration. The earlier registry observation of 0.5.23 is historical. The 0.6.0 candidate is installed on a dedicated managed validation identity with private synthetic stores; the production agents retain their existing runtimes.

The installed Windows canary uses Node 24.14.0, AGY 1.3.5 and Buzz Desktop 0.5.28. It passed acknowledged real relay delivery, independent Desktop thread readback and visual Activity inspection. Three real in-flight corrections succeeded on their existing provider processes, each with a hook acknowledgement followed by a matching user-input step, one corrected final reply, no cancellation and no fallback. The last two steering probes used the forward-only hook router without temporary metadata instrumentation. Explicit cancellation before a first checkpoint recovered into a fresh conversation; cancellation after a saved checkpoint and the native Desktop `Restart agent` workflow resumed the same saved conversation without replaying the interrupted input.

The final observation window delivered exactly 24 expected replies from 2026-10-15T16:26:46.846Z through 17:27:30.812Z, spanning 60.733 minutes. All corresponding event IDs were distinct and acknowledged; no duplicate marker, obsolete final response, cancelled-turn final response or unresolved delivery appeared in that window. The checkpoint remained in the same conversation and ended `ready`, with no active direct provider. All eleven post-update production process identities were preserved in the collected samples. A replacement observer initially exited because of a UTC/local-time comparison; manual per-turn samples and finite probe traces were retained, and the observer was corrected. These are sampled observations, not uninterrupted process surveillance.

The final installed revision is source `1b44f2fa0ef71eb76adc6fa7dcbb8d6a496822a4`, archive SHA-256 `6038b50c7dc6661c5223b22e53e054f30c1e8a976475f347669ac8d14a699da7`. The window contains six successful turns on `654b53fccca3a52e3c72152f65f56ef9dda0ce3d`, eleven on `291ba44ec7ab2da094a57a46b7053ea3c9b405cb` and seven on the final revision. The transitions changed only error classification and fixed diagnostic messages; the hook and session-core bytes were unchanged. The final revision was activated through Desktop, resumed the saved conversation and passed real steering again. This is a qualified multi-revision observation, not a one-hour single-build soak. These observations do not establish power-loss safety, arbitrary descendant cleanup, a 24-hour soak or universal future-provider compatibility.

For the final runtime source, `npm run check` recorded 524 tests: 520 passed, four local Windows symlink-privilege skips and zero failures, followed by package dry-run validation. The extracted package smoke passed. CI completed all eighteen checks on that source; one exploratory Node 26 Windows job initially refused ACL inspection at approximately its ten-second helper bound and passed after one targeted rerun. The required Node 22/24 jobs passed. The same four locally skipped symlink tests were explicitly exercised by the Windows CI lanes during this candidate's validation. The helper's privacy checks and deadline were not weakened.

The adapter advertises ACP protocol version 1. Checkpoint record version 1 is retained inside the explicitly marked canonical store format 1, with lowercase UUID keys and owner/relay binding. Unmarked nonempty stores require [explicit migration](STATE_MIGRATION.md). Outbox version 1 is readable legacy evidence; version 2 binds new records and stores to an account and relay fingerprint. These implemented formats are candidate changes, not evidence of an installed migration or future provider compatibility.

The reproducible probes are `scripts/provider-canary.mjs` and `scripts/provider-timeout-probe.mjs`. The installed 1.3.5 binary SHA-256 observed during the timeout check was `4790560754318d0ced2358d13cbce9181dfc51d1964c3d95c9776e8eaf5cd3c4`. With a two-second print-timeout and open stdin but no prompt, it emitted `init` and remained alive until explicitly terminated after eight seconds. This disproves a universal timeout measured from process start in that environment; it does not determine the active-turn timeout clock. Keep the conservative 24-hour pin and 21-hour rotation policy while characterizing provider updates separately.

When changing runtime support, verify the maintained Node.js LTS majors, update the engine and blocking CI matrix together, and keep exploratory majors explicitly non-blocking until they are adopted as supported targets. Keep the fixture suite and extracted-package smoke test in the blocking matrix for each supported OS and Node major. Refresh `package-lock.json` from the declared dependency graph, keep `bundledDependencies` aligned with the packages required by the extracted runtime, and preserve each dependency's license metadata. Pin GitHub Actions to full commit SHAs verified against their official version tags, with the version retained in a comment. Date and label local version observations separately from fixture results and live-provider or Buzz installation checks.

## Release status and succession

| Version | Status | Operational meaning |
| --- | --- | --- |
| 0.6.0 | Unreleased candidate | Dedicated installation, real relay/steering/recovery and 24-turn, 60.733-minute qualified observation completed. No release publication. |
| 0.5.8 | Historical public release | The published release documented below. |
| 0.5.9 | Superseded draft | Already installed in some environments; preserve its archive and exact checksum for rollback history. |
| 0.5.10 | Existing release line | Use published v0.5.10 release assets when available; draft assets are not releases. |

The 0.5.10 release line is based on source commit `8e9886c836b5c96fb0347027327c334237fa4a4a`, with the same tree as commit `5e24970`. The initial candidate archive used for these checks had SHA-256 `dc53db97ce8bb1ad61aa985afec10ec72a99d47cc22a0731f28398ec65418750`; for a later documentation-only rebuild, use the current archive checksum in the release notes because this hash identifies the tested initial candidate. Candidate checks recorded 457 tests: 453 passed, 0 failed and 4 skipped; CI runs [34709072710](https://github.com/ironlegends/agy-buzz-acp/actions/runs/34709072710) and [34709074250](https://github.com/ironlegends/agy-buzz-acp/actions/runs/34709074250) each completed 9/9. These are source, package and CI checks; they do not by themselves constitute live 0.5.10 Buzz validation.

An authorized isolated real-relay proof on 2026-09-12T19:08:56Z with agy 1.2.2 and BuzzPublisher completed three turns across recreation of the ACP server within the same Node.js process. Each turn used a new provider process, provider close preceded publication, and durable checkpoints reached `ready`. The replacement server rejected the stale ACP session ID with code `-32001` and message `provider request failed`, accepted a new session, and resumed the same durable conversation. Exactly three expected responses were published during this instrumented run. Independent relay readback matched their event IDs and contents; signature fields were recorded but were not independently verified cryptographically. This establishes relay delivery and durable state reuse after in-process server recreation, not termination and relaunch of the adapter process or use of the Desktop Restart button.

An additional authorized real-relay check completed on 2026-09-12T19:57:04Z using the current archive with SHA-256 `6fbff68a2149b2c6b070e94b2c54d687babd911ab14a23b4c9ecd34cb10d1ea5`. The unchanged extracted adapter entrypoint ran in two separate Node processes with a test-only child-lifecycle trace hook. After two turns, EOF closed the first adapter with exit code 0 before the second was spawned. The second rejected the stale ACP session with `-32001`, opened a new ACP session and resumed the same durable conversation for a third turn. All three providers closed before their corresponding publications; all three outbox records were `sent` and checkpoints were `ready`. Separate CLI readbacks matched the three event IDs, expected markers, author and reply thread. No replay occurred within this instrumented run. The second adapter also closed with exit code 0. Before/after observations matched all ten production adapter PIDs and creation timestamps. This establishes process restart recovery for the isolated CLI run, not the installed Desktop Restart workflow.

An explicitly authorized isolated Desktop canary validation completed on 2026-09-12 after a Desktop `Restart agent`. The checkpoint remained `ready` and retained the same durable conversation before and after the restart. In the observed window, the canary produced exactly two expected responses, one before and one after the restart; relay readback and outbox records showed both delivered as `sent`, with no duplicate or replay observed. The canary Activity transcript showed `Session ready · New session created`, `Model generation`, the expected response marker and `Response sent` after the restart. The ten production adapter PIDs and creation timestamps remained unchanged before and after the canary restart. This establishes the nominal same-conversation path after a Desktop restart and the observed no-replay window. Desktop did not expose individual child EOF/exit records or raw ACP session IDs, and this nominal probe did not test interruption or uncertain-turn behavior.

No deployment or publication occurred during this validation. The 0.5.9 release notice/readback retains its draft target asset IDs, digests and timestamps with title `Superseded`; ten observed processes remained on 0.5.9.

Preserve the 0.5.9 archive and checksum separately from the 0.5.10 release line. The versions remain distinct because 0.5.9 is already installed in some environments; never rewrite its rollback artifact or silently replace it.

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
