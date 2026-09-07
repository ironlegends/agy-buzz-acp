---
title: "Local installation upgrades and rollback"
tags: [upgrading, rollback, installation]
status: active
created: 2026-09-07
---

# Local installation upgrades and rollback

`agy-buzz-manage` installs a verified release archive into a versioned runtime directory and updates one existing Buzz harness. It never starts the adapter, reloads Buzz settings, or runs code from the archive while validating it.

The command is a dry run by default. Obtain the expected SHA-256 from the trusted release publication or its separately authenticated checksum, then inspect the plan:

```text
agy-buzz-manage install --archive agy-buzz-acp-0.4.0.tgz --sha256 <sha256> --root C:\agy\agy-buzz-acp --harness C:\Users\me\harness.json
```

The archive must be a gzip compressed tar file with the npm `package/` layout. The manager checks the digest before parsing, requires package name `agy-buzz-acp`, a valid semantic version, the package file allowlist, and the adapter entrypoint. Absolute paths, traversal paths, duplicate entries, symlinks, hardlinks, and unsupported tar entry types are rejected. Validation parses `package.json` as data and does not import or execute archive files.

Apply the displayed plan only after reviewing it:

```text
agy-buzz-manage install --archive agy-buzz-acp-0.4.0.tgz --sha256 <sha256> --root C:\agy\agy-buzz-acp --harness C:\Users\me\harness.json --apply
```

The release is extracted into `root\versions\agy-buzz-acp-<version>`. The original harness bytes are preserved at the unique `harness.json.<timestamp>-<id>.backup` path shown in the result, with a matching `.receipt.json` association record. Its `id`, `label`, `command`, and `env` remain unchanged, and only the adapter entrypoint in `args[0]` is changed. Existing backup and receipt paths are never overwritten. If the harness changed after planning, the operation stops before writing.

To roll back, ensure the previous adapter entrypoint recorded in the backup still exists, then inspect the rollback plan:

```text
agy-buzz-manage rollback --backup C:\Users\me\harness.json.<timestamp>-<id>.backup --harness C:\Users\me\harness.json
```

Apply the rollback explicitly:

```text
agy-buzz-manage rollback --backup C:\Users\me\harness.json.<timestamp>-<id>.backup --harness C:\Users\me\harness.json --apply
```

Rollback verifies the receipt’s harness binding and exact current and backup digests, checks both the current and previous entrypoints, and refuses a conflict. It restores the backup bytes exactly, preserves the replaced installed harness at the unique `rollback-current` path shown in the result, and leaves the backup, receipt, and installed files in place. The manager serializes its own operations with a lock; an external editor must be closed for the duration of the apply command. Restarting an adapter or reloading Buzz settings remains an operator action.
