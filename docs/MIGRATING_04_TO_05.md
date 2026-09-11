# Migrating from 0.4.x to 0.5.8

This is an opt-in operational migration, not a transparent patch update. An existing pinned 0.4.1 installation or personal fork is not rewritten when this repository publishes 0.5.8. A checkout tracking `main`, a reinstall from the latest archive, or a personal updater may select the new code: review those choices explicitly. There is no automatic runtime installer in this adapter.

## What changes

| Area | 0.4.1 | 0.5.8 |
| --- | --- | --- |
| ACP text replies, model catalogue and provider sandbox | Supported | Retained |
| Missing publication directive / empty answers | Xeoneid fix plus maintainer resume coverage | Same fixes retained with original attribution |
| Correcting an active turn | No native steering extension | Opt-in `_session/steering` and a dedicated PostInvocation hook |
| Ownership and retry locks | Directory-based ownership/claims | Native OS file locks with bundled native dependency |
| Durable checkpoint lifecycle | Earlier continuity/rotation design | A successfully delivered durable turn retires the provider before readiness; the next turn starts a provider and resumes the same validated conversation |
| Recovery after an interrupted provider | Earlier blocked-state behaviour | Guarded reconstruction of AgySession after confirmed close, scoped durable association and settled outbox |
| Runtime dependencies | No native locking dependency | Install the complete archive; copying only JavaScript is insufficient |
| Ambiguous destination | Refusal | Explicit Context remains authoritative; only a single validated event can supply the 0.5.8 fallback |

Steering is off unless its explicit hook/owner/exclusive-injector prerequisites are configured. **Disabling steering does not revert the locking, packaging or durable-checkpoint changes.** With neither durable state nor steering enabled, the lightweight process-reuse/rotation path remains; with durable state enabled, account for provider startup/resume latency each turn. Automatic reconciliation additionally requires an enabled readable outbox. No configuration promises exactly-once external tool execution.

## Preserve a working 0.4.1 installation

Keep the existing archive, lockfile, configuration and personal work on a branch or tag. Use the published `v0.4.1` tag/archive rather than a moving `main` to reproduce that baseline. Do not reset a contributor branch, force-push its history or share live state directories between versions. Retaining an old release does not promise indefinite maintenance or continued provider compatibility.

For a collaborator such as Xeoneid, merge conflicts from rebasing private changes are a separate concern from running the adapter. The original contribution is retained; a collaborator can continue on 0.4.1 and test 0.5.8 in an isolated worktree before deciding to port additional changes. Neither their private code nor their environment has been audited by this project.

## Staged migration and rollback

1. Record the old adapter, Node, Buzz and agy versions, and save the old archive, harness and any hook configuration. Commit or back up personal changes first.
2. Test 0.5.8 in a separate versioned directory with fresh private session/outbox/steering directories. Do not point two running versions at the same stores. Native prebuild availability and ACL permissions must be verified on the target machine.
3. Stop the affected agent and confirm its adapters/providers and any steering operations have settled. Inspect uncertain external effects before changing state. Preserve legacy directory locks; never delete them merely to make startup pass. Use a new state directory for an intentionally fresh conversation, or an explicitly reviewed migration for continuity.
4. Install the full verified archive. `agy-buzz-manage` changes only the adapter entry point in the harness; it does not rewrite the separate hook/plugin configuration. If steering is enabled, update the dedicated hook to the same runtime version and preserve its old configuration.
5. Reload the Desktop harness catalogue, start only the affected agent, and verify the announced version, normal reply, resumed conversation, sent event and ready checkpoint. Keep fault-injection tests separate from business conversations.
6. On rollback, stop the affected processes again. Restore both the previous harness and the matching hook configuration (or leave steering disabled if the old version has no steering), then reload the catalogue. Preserve new-version states separately: restoring an old harness does not reverse a state migration or external effects.

See [upgrades](UPGRADING.md), [recovery](OFFICIAL_BUZZ_RECOVERY.md), and [compatibility evidence](COMPATIBILITY.md).

## Version numbers

The 0.4 to 0.5 boundary signals material lifecycle, persistence and packaging changes; it should not be disguised as 0.4.2. The 0.5.8 suffix records intermediate 0.5.x development/installations, not a requirement for users to install eight intermediate versions. Released tags and archives are not rewritten to renumber that history.

SemVer treats `0.y.z` as initial development, not a stable public API. This is not permission to hide breaking changes: future incompatible persistence or configuration changes should use a new minor line, explicit migration notes and prereleases where useful. Compatible fixes/diagnostics can use a patch release. See [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

For npm range users, `^0.4.1` excludes 0.5.8 (`>=0.4.1 <0.5.0`); a Git branch reference, broad range or latest-archive script has different update behaviour. This project distributes archives, so do not assume a registry range controls a manually installed runtime. See [node-semver caret ranges](https://github.com/npm/node-semver#caret-ranges-123-025-004).
