# Manager rollback failure and interruption recovery

The manager uses an exclusive filesystem marker, `<harness>.agy-lock`, to serialize changes to one harness. It is not the native session-ownership lock and does not automatically disappear when a process is killed.

## Recoverable exceptions in this patch

Rollback first moves the current harness to a unique `rollback-current` claim and validates its bytes. If linking the restored harness then fails, it attempts to relink the claim only when the harness path is absent. An external file that appeared concurrently is never overwritten. The operation still reports the original failure; restoration is best-effort and is not reported as a successful rollback. If both links fail, the claim retains the previous bytes for manual inspection. Only this operation's staging file and directory are cleaned up, on a best-effort basis.

Synthetic tests cover a failed publish link, a concurrent external edit, a second failure during restoration, an exception before publication, and successful rollback cleanup. These are exception-path tests, not proof of recovery after process death or power loss.

## Remaining interruption windows

A killed manager can leave the marker, a staging directory, a runtime installed before its harness changed, or a claim without a harness at its original path. Individual file operations do not make the sequence transactional. JSON that parses and an entrypoint that exists are not sufficient to prove that the whole installation matches the intended version, hook and receipt.

Do not remove a marker based solely on age or a historical PID. Establish exclusive maintenance access to this harness and confirm that no manager or external editor can change it while it is inspected. Preserve the marker and all claim, backup, receipt and staging files first. Compare the exact current and backup digests, identity, entrypoints and receipt association against the reviewed plan. Inspect the hook separately. Do not share local configuration contents, paths or credentials in a public issue.

An absent harness requires an explicit recovery decision; do not blindly relink the newest claim or retry installation. When an operator has verified the files and exclusive access, they can decide whether to clear only the stale marker and obtain a fresh dry-run plan. Never treat removal of that marker as restoration of the configuration or reversal of external effects.

A bounded phase journal is written next to the harness as
`<harness>.agy-journal.json`. It contains only the operation kind, phase,
timestamps, exact paths and SHA-256 digests; it never records the harness
environment, credentials or file contents. The journal is replaced atomically
under the existing manager marker. Critical installation and rollback steps
record their phase before and after the effect, including the exact claim path
before the current harness is moved.

A new `install` or `rollback` refuses to replace an unfinished, failed or
ambiguous journal. An operator must preserve and inspect that evidence before
starting another operation.

Use the existing manager command for a read-only inspection:

```sh
agy-buzz-manage diagnose --harness C:\\Users\\me\\harness.json
```

The diagnostic bounds journal, file and claim reads, checks the requested
harness path, claim, backup and receipt associations, and reports
`consistent`, `interrupted` or `indeterminate`/`insufficient-evidence` when
the files cannot establish a complete sequence. An interrupted claim can be
identified by its exact digest while the harness path is absent. A conflicting
digest, an incomplete journal, an unsafe path, an unreadable file, an
ambiguous set of claims or an unresolved marker remains indeterminate. A
marker's age, a historical PID, a single newest claim, or the presence of a
valid JSON file is never treated as ownership or permission to restore.

Diagnosis acquires no lock and performs no write: it never relinks a claim,
deletes a marker or staging directory, retries an installation, or removes an
uncertain effect. Manual recovery must first establish exclusive maintenance
access, preserve every claim/backup/receipt/staging artifact, and compare the
reported paths and digests against the reviewed operation. Only an operator
who has independently verified those facts may decide what to do next.
