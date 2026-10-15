# Canonical session-state store migration

Session ownership now treats UUID channel IDs as lowercase identities. A fresh, empty `AGY_SESSION_DIR` receives a `.agy-session-state-store` marker while the process holds the native store-initialization lock. The marker records the format, lowercase UUID key rule, configured owner ID, and SHA-256 hash of the normalized relay endpoint. It never stores the relay URL.

An unmarked, nonempty store refuses runtime ownership before creating channel locks or changing its contents. This protects old records and lock files whose channel casing is unknown. Runtime initialization does not infer that an old directory is safe to reinterpret.

Migration is an explicit two-step operation. First stop every adapter or other writer that used the legacy directory. Old and new versions must not write to the same store during migration. Choose a separate destination path that does not exist; its parent directory must already exist and be private. Set `AGY_SESSION_OWNER` and `BUZZ_RELAY_URL` (or `AGY_RELAY_URL`) in the environment.

Run a read-only validation first:

```powershell
node .\bin\agy-buzz-state.js --source C:\path\to\legacy-state --destination C:\path\to\canonical-state
```

Then apply the migration with the same inputs and `--apply`:

```powershell
node .\bin\agy-buzz-state.js --source C:\path\to\legacy-state --destination C:\path\to\canonical-state --apply
```

The command holds every associated legacy channel lock through validation and publication. It accepts only strict v1 records and their existing native lock files. It refuses held or missing locks, UUID case-folding collisions, blocked-record changes, malformed records, hard links, symbolic links, opaque locks, unknown files, an existing destination, or unsafe path ancestors. Blocked records stay blocked. The source record bytes and directory entries remain unchanged.

Apply builds and validates a private staging directory beside the destination, then publishes the complete directory in one rename. If a failure leaves a staging directory, the command reports its path and leaves it as evidence. A later run does not resume or replace that stage; inspect and resolve it before another attempt. After a successful apply, point `AGY_SESSION_DIR` at the new destination. Keep the old source until the new runtime has been checked.
