---
title: "Outbox relay compatibility and retention"
tags: [outbox, relay, compatibility, retention]
status: active
created: 2026-09-12
---

# Current outbox contract

Version-1 delivery records contain the recovery identity, owner, channel,
destination reply, content and delivery timestamps/status. The durable
`channelId` and `replyTo` fields identify the local delivery target; they do
not prove which relay accepted the event. The current record format has no
relay identity, relay fingerprint or retention policy field. An ACK with an
event ID proves only the acknowledgement represented by that record; it does
not create a persisted relay association.

Keep outbox directories separate by Buzz account and relay. A directory must
not be reused after changing account or relay, even when its records have
valid JSON, a matching channel, or a `sent` status. Existing records remain
readable when they satisfy the version-1 validation rules. They are never
silently rewritten to add relay metadata. `inflight` and `uncertain` records
remain protected evidence: they are not replayed, reassigned to the current
relay, or purged as part of stabilisation. Retention is therefore an explicit
operator decision and is outside the current runtime contract.

# Future migration boundary

Persisted relay linkage and retention require a separately reviewed,
versioned schema and migration procedure. A future schema may carry a
canonical relay fingerprint, account binding and an explicit retention
policy. The migration must be voluntary and preserve old records without
rewriting them. An old record must never be attributed automatically to the
current relay. Promotion to the new schema requires independently verified
provenance for the account, relay and delivery acknowledgement.

During migration stabilisation, no `inflight` or `uncertain` record may be
replayed, reassigned or purged. A migration must not turn a missing or
ambiguous relay association into a successful delivery claim. Until that
design and its provider/relay proof exist, use a new account/relay-specific
directory and retain the old directory for manual inspection.

This document describes compatibility boundaries only. It does not change
the version-1 records or implement relay migration, automatic retention or
cleanup.
