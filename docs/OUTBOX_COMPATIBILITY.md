---
title: "Outbox relay compatibility and retention"
tags: [outbox, relay, compatibility, retention]
status: active
created: 2026-09-12
---

# Outbox schemas and compatibility

## Version 1 records

Version-1 records contain the recovery identity, account owner, channel,
destination reply, content, delivery status and timestamps. They carry no relay
association. The channel and destination fields do not prove which relay
accepted an event.
The stored `channelId` and `replyTo` identify the delivery target, while
`eventId` is the acknowledgement represented by a sent record.

Version-1 records remain readable by the direct
`DeliveryOutbox({ dir, owner })` constructor and by a configured
outbox. The direct constructor is a read-only legacy reader. Configured writers
require `AGY_OUTBOX_DIR`, `AGY_OUTBOX_OWNER` and
`BUZZ_RELAY_URL`. A configured outbox may inspect an unmarked
version-1 store, but it cannot write to it or retry its records. No operation
silently promotes a version-1 record or assigns it to the current relay.

## Migration and rollback

There is no automatic v1-to-v2 migration: v1 lacks independently verified relay
provenance. Preserve its original directory, inspect unresolved deliveries, and
reconcile their actual outcome before enabling a separate v2 directory. Choosing
a new directory never settles or reassigns old deliveries. Never copy inflight
or uncertain records into a new relay scope. For rollback, stop all affected
writers, restore the previous runtime and matching configuration, and preserve
the new directory separately. Older adapters must never write to a v2 store.

## Version 2 stores

A new store starts with the non-record marker
`.agy-outbox-store`. Its strict JSON fields are
`schemaVersion: 2`, the lowercase account `owner`, and
`relayFingerprint`. The fingerprint is SHA-256 over the canonical
relay URL. The URL is never written into the marker or a delivery record.

Relay URLs must use `ws:`, `wss:`, `http:` or
`https:`. User names and passwords are rejected. URL fragments and
trailing path slashes are removed; the URL host is normalized and the query is
preserved before hashing. A different account or relay cannot open a marked
store for reading or writing.

New records use `schemaVersion: 2` and the matching
`relayFingerprint`, with the same owner and delivery fields as v1.
The record validator accepts only the exact v1 or v2 field set. A v2 record
without a valid fingerprint is corrupt, and a v2 record without its matching
store marker is rejected.

The marker is initialized under a native store lock only in an empty directory.
An unmarked nonempty directory remains read-only, including stores with legacy
records, lock files, unknown files or interrupted temporary files. Changing
the account or relay requires a separate store.

## Recovery scans and listing

`hasUnsettledDelivery(channelId)` streams the complete record
directory with bounded per-record reads and bounded memory. `sent`
records with a valid event acknowledgement are settled. `inflight`,
`uncertain` and `failed-before-start` records remain
unsettled and block the channel. Invalid, unreadable or disappearing records
fail the scan closed. The decision does not stop at a fixed history limit.

`listPage({ after, limit })` retains only the requested bounded page
and one cursor candidate, then returns `{ records, nextCursor }`.
Pages are ordered by recovery ID; pass the previous `nextCursor` as
`after` for the next page. The maximum page size is 1,000.
`list()` remains available for callers that need at most 1,000
records and reports an error when that compatibility limit is exceeded.

The recovery CLI requires an explicit page size:

`agy-buzz-recover list --limit 100 [--after recovery-id]`

## Explicit sent-record archive

`agy-buzz-recover archive-sent --archive-dir <separate-path>` is a
dry run. Add `--apply` to archive. The destination cannot overlap the
active outbox, use a symlink ancestor, or overwrite an existing entry. An
existing POSIX archive directory must have private permissions.

Only valid `sent` records with an acknowledged event ID are eligible.
The archive command takes each record's native lock, creates its destination
with exclusive creation, copies the exact source bytes, verifies the copy and
source identity, then removes the active record. Uncertain, inflight and
failed-before-start records remain untouched. Archived v1 records retain
their original bytes and do not gain a relay association. A crash can leave a
duplicate sent record in both locations; the active copy is removed only after
the archive copy has been verified.

Archiving is an explicit operator action. There is no automatic retention
timer.
Stop affected adapter writers before operator archival or retry maintenance.
This avoids treating paginated listings as a transactionally stable snapshot
while another process changes delivery status. The complete runtime scan is
serialized by normal channel ownership; it is not a filesystem snapshot against
arbitrary external mutation.
