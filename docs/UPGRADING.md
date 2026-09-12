---
title: "Local installation upgrades and rollback"
tags: [upgrading, rollback, installation]
status: active
created: 2026-09-07
---

# Local installation upgrades and rollback

`agy-buzz-manage` installs a verified release archive into a versioned runtime directory and updates one existing Buzz harness. It never starts the adapter, reloads Buzz settings, or runs code from the archive while validating it. Archives from version 0.5.3 onward include the native file-lock dependency and its bundled support packages; install the complete archive.

## Version succession

Version 0.5.10 is the current release line. Use the published v0.5.10 release assets when available; draft assets are not releases. Version 0.5.9 was a draft superseded by 0.5.10; some installations already run 0.5.9, so preserve its archive and exact checksum as rollback evidence and never overwrite or delete them. The historical v0.5.8 release and its evidence remain documented separately. Keep the versioned runtime directories and rollback artifacts distinct.

Before migrating from 0.4.x, read [the migration guide](MIGRATING_04_TO_05.md). Stop the affected agent and confirm its providers and pending steering have settled; back up the harness, dedicated hook/plugin configuration and durable stores. Do not point different live versions at the same stores.

The command is a dry run by default. Obtain the expected SHA-256 from the trusted release publication or its separately authenticated checksum, then inspect the plan:

```text
agy-buzz-manage install --archive agy-buzz-acp-0.5.10.tgz --sha256 <sha256> --root C:\agy\agy-buzz-acp --harness C:\Users\me\harness.json
```

The archive must be a gzip compressed tar file with the npm `package/` layout. The manager checks the digest before parsing, requires package name `agy-buzz-acp`, a valid semantic version, the package file allowlist, and the adapter entrypoint. Absolute paths, traversal paths, duplicate entries, symlinks, hardlinks, and unsupported tar entry types are rejected. Validation parses `package.json` as data and does not import or execute archive files.

Apply the displayed plan only after reviewing it:

```text
agy-buzz-manage install --archive agy-buzz-acp-0.5.10.tgz --sha256 <sha256> --root C:\agy\agy-buzz-acp --harness C:\Users\me\harness.json --apply
```

The release is extracted into `root\versions\agy-buzz-acp-<version>`. The original harness bytes are preserved at the unique `harness.json.<timestamp>-<id>.backup` path shown in the result, with a matching `.receipt.json` association record. Its `id`, `label`, `command`, and `env` remain unchanged, and only the adapter entrypoint in `args[0]` is changed. Existing backup and receipt paths are never overwritten. If the harness changed after planning, the operation stops before writing.

**Steering hook is a separate configuration:** the manager changes only harness `args[0]`, not the hook command. After installation, update an enabled dedicated hook to the same versioned runtime; preserve its old configuration. Reload Settings → Agents → Check again and restart the affected agent. Verify the version announced at initialization and a delivered/checkpointed test turn.

To roll back, stop the affected agent again, restore the matching previous hook configuration as well as the harness (or keep steering disabled for an older runtime without it), and preserve new-version state separately. The manager does not migrate state backward or undo external effects. Ensure the previous adapter entrypoint recorded in the backup still exists, then inspect the rollback plan:

```text
agy-buzz-manage rollback --backup C:\Users\me\harness.json.<timestamp>-<id>.backup --harness C:\Users\me\harness.json
```

Apply the rollback explicitly:

```text
agy-buzz-manage rollback --backup C:\Users\me\harness.json.<timestamp>-<id>.backup --harness C:\Users\me\harness.json --apply
```

Rollback verifies the receipt’s harness binding and exact current and backup digests, checks both the current and previous entrypoints, and refuses a conflict. It restores the backup bytes exactly, preserves the replaced installed harness at the unique `rollback-current` path shown in the result, and leaves the backup, receipt, and installed files in place. The manager serializes its own operations with a lock; an external editor must be closed for the duration of the apply command. Restarting an adapter or reloading Buzz settings remains an operator action.
