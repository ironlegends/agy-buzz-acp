## Historical design document (version 0.2.0)

> Note: This document describes historical version 0.2.0 design and is superseded by `docs/OFFICIAL_BUZZ_RECOVERY.md` and `docs/COMPATIBILITY.md` for the current release.

The 0.2.0 work keeps the provider sandbox and Buzz routing contract. Portable diagnostics, installation examples and CI are separate from lifecycle recovery.

Durable conversation recovery is opt-in. A ready association must match the current verified Buzz identity, relay, canonical working directory, model and channel. A new turn invalidates readiness before side effects. An interrupted or uncertain turn must not become silently ready after shutdown. Locks prevent concurrent ownership, and releasing a lock requires the old child to have exited.

The process lifetime strategy rotates only between complete turns with enough headroom for Buzz's maximum turn duration. The replacement must confirm the same conversation identifier before receiving a prompt.

No prompt or private authentication data belongs in session-state records. Windows ACL privacy requires separate operator verification. A stale lock remains a conservative operator boundary, not an excuse to replay work.
