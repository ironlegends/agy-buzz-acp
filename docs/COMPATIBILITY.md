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

## Known baseline

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
8. Publish the repository and archive with accurate compatibility limitations. Registry publication is a separate distribution option.

## Local data protection

Use an operator-provisioned private local directory for optional persistence. On POSIX, verify owner and mode. On Windows, verify effective ACLs for the Buzz account; chmod-style modes alone are insufficient. Local state is plaintext. Do not synchronize it between machines or identities.

A pending or uncertain operation is a recovery boundary, not evidence that nothing happened. Inspect actual provider/relay state before manual reconciliation. Never delete a lock or record merely to force an automatic retry.

## Shutdown limitation in Buzz

Durable recovery requires an orderly adapter shutdown. The Buzz shutdown path inspected for the local installation kills the ACP child without closing its stdin first. Even a successfully delivered turn can therefore leave a session lock behind and block the next launch. Do not enable durable state expecting automatic recovery from that shutdown path. A future integration must demonstrate lock cleanup after a delivered turn and restore the same conversation without replay or duplicate publication. Do not remove locks automatically to hide this limitation.
