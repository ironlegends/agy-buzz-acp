# agy-buzz-acp

A minimal-dependency ACP stdio bridge between Buzz and the official Antigravity CLI (`agy`). It preserves one provider conversation per Buzz session, reports activity separately from the answer, and publishes the final answer through the Buzz CLI.

This is a community adapter for Buzz. It is not a general-purpose ACP client adapter, a Google product, or a replacement for either CLI.

## Requirements

- Node.js 20 or newer.
- Buzz Desktop and the Buzz CLI, with a managed agent identity configured by Buzz.
- Antigravity CLI installed and authenticated separately through its official flow.
- A provider model available to your account. The default is `gemini-3.8-flash-high`; `AGY_MODEL` selects another model at adapter startup.

The JavaScript runtime uses standard Node APIs. Windows has real-provider validation; Linux and macOS require their own provider smoke tests. Automated fixture CI does not prove provider availability, account eligibility, or graphical rendering on every OS.

## Install and register

Download an archive from the [releases page](https://github.com/ironlegends/agy-buzz-acp/releases), or build from a source checkout:

```sh
npm ci
npm test
npm pack
```

Install the generated archive, or an archive from a reviewed release:

```sh
npm install --global ./agy-buzz-acp-0.5.3.tgz
```

The package provides `agy-buzz-acp`, `agy-buzz-recover`, `agy-buzz-doctor`, `agy-buzz-manage`, and `agy-buzz-steer-hook`. The native file-lock dependency and its bundled support packages are included in the release archive. No npm-registry publication is required to install the archive.

Generate the custom harness settings using your actual installation paths:

```sh
agy-buzz-acp setup
```

The command searches your explicit `AGY_COMMAND` and `BUZZ_CLI_COMMAND` paths first, then PATH and documented standard installation locations. It prints JSON containing absolute Node, adapter, agy and Buzz paths. Copy these values into a custom harness in Buzz Settings. It does not install software, write application settings, authenticate, or include your credentials in the output.

If an explicit path is wrong, correct it; the resolver will not silently use another installation. On Windows, select real executables such as `agy.exe` and `buzz.exe`, not `.cmd`/`.bat` shims. The adapter never enables a shell to launch a batch shim. For unusual installation layouts, use the [manual examples](examples).
Run the doctor before selecting the runtime for an agent:

```sh
agy-buzz-doctor
```

The default diagnostic is offline and does not log in, send messages, run provider prompts, or print credentials. See `agy-buzz-doctor --help` for supported options. Installation does not edit your Buzz configuration, install the provider, or change permissions automatically.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGY_COMMAND` | Antigravity executable; defaults to `agy` on PATH. |
| `BUZZ_CLI_COMMAND` | Buzz executable; defaults to `buzz` on PATH. |
| `AGY_MODEL` | Provider model selected at process startup. ACP prompts cannot override it. |
| `AGY_SESSION_DIR` | Optional trusted local directory for durable conversation associations. |
| `AGY_SESSION_OWNER` | Public Buzz identity, 64 hexadecimal characters; required with the session directory. |
| `AGY_OUTBOX_DIR` | Optional trusted local directory for final answers and delivery state. |
| `AGY_OUTBOX_OWNER` | Public Buzz identity, 64 hexadecimal characters; required with the outbox directory. |
| `AGY_STEER_HOOK_CONFIGURED` | Set to `1` only when the dedicated official agy PostInvocation hook is installed and configured. |
| `AGY_STEER_INJECTOR_EXCLUSIVE` | Set to `1` only when this hook is the sole steering injector for the provider. |
| `AGY_STEER_OWNER` | Public Buzz identity, 64 hexadecimal characters; falls back to `AGY_SESSION_OWNER`. |
| `AGY_STEER_ROOT_DIR` | Optional trusted local directory for steering bridge state. |

Buzz supplies its own relay and managed identity environment. Do not copy another installation's credentials or embed them in custom harness examples. Optional state belongs to the local installation and identity.

## Discover and select models

```sh
agy-buzz-acp models
```

This command queries the official `agy models` catalog and returns JSON usable by Buzz's model probe. Unlike `setup` and the default doctor, it can contact the provider using agy's existing authentication. It does not start a conversation, log in, or publish a message. Requests have bounded time and output; raw provider diagnostics are not printed.

New ACP sessions expose the available models as select configuration options. The initial model remains `AGY_MODEL`, or `gemini-3.8-flash-high` by default. A client may choose an offered model with `session/set_config_option` before the first prompt. After a prompt starts, changing the model requires a new conversation. The adapter never resets an existing conversation to accommodate a model switch.

Persisted conversations retain their model scope. Selecting a different model cannot restore old state under that new model; follow the explicit fresh-conversation procedure below if that is what you intend.

If catalog discovery fails, the configured model remains usable and no model list is invented. Check the official CLI's installation and authentication separately. ACP `initialize`, CLI help/version, setup and offline doctor do not query the model catalog.
## Activity and delivery

Activity Log distinguishes provider generation, available tool activity, and Buzz delivery. Activities carry unique IDs and available durations. Parameters, raw tool results, provider errors and hidden reasoning are not forwarded.

The provider protocol examined does not expose a textual reasoning summary. No synthetic `agent_thought_chunk` is generated. The final provider response is published separately from activity events.

Delivery states:

| State | Meaning and recovery |
| --- | --- |
| `sent` | Buzz returned `accepted: true` and a valid event ID. Do not retry. |
| `failed-before-start` | Publisher did not start. A retained answer can be retried without re-running the model. |
| `uncertain` | Publication may have happened. Reconcile with the relay before any further action; automatic retry is refused. |
| `inflight` after restart | Treated as uncertain. |

## Conversation continuity

The adapter rotates an aging provider process between completed turns, at 21 hours, leaving three hours before agy's 24-hour process limit (one hour of dispatch margin beyond a two-hour Buzz turn). It waits for the old child to close, starts `agy --conversation` with the confirmed identifier, and requires a matching `init` before sending the next prompt. Rotation does not interrupt an active turn or replay a previous prompt.

For optional continuity across adapter termination and restart, configure both `AGY_SESSION_DIR` and `AGY_SESSION_OWNER`. Buzz must supply `BUZZ_RELAY_URL`. A configured `AGY_RELAY_URL` must agree with that actual publisher endpoint; it cannot silently override it for session recovery. Version 0.5.3 uses native OS locks, so recovery does not depend on a graceful Buzz shutdown after a completed checkpoint.

Associations are scoped to the verified public Buzz identity, relay, canonical working directory, model and channel. They contain an identifier and scope metadata, not conversation text or credentials. A channel lock prevents concurrent owners. The adapter only records readiness after successful final-answer delivery and invalidates readiness before the next turn.

Interrupted or uncertain work, corrupted state and mismatched scope block automatic recovery. A native lock file may remain after release; its presence is not evidence of an active owner. An incomplete or uncertain turn still requires operator reconciliation. The adapter does not automatically remove lock files, replay interrupted work or reconcile uncertain relay publication. The recovery CLI described below is for retained answers, not for overriding conversation locks.

If a conversation is blocked, stop its adapter and reconcile the provider and relay state first. To deliberately start a new conversation after that check, configure a new empty private session directory and preserve the old directory as evidence. This is an operator decision that discards continuity; it is not automatic recovery or prompt replay.

Use a separate private state directory for each managed identity. Do not copy these records between machines. The same plaintext and Windows ACL limitations as the outbox apply.
## Retaining an undelivered answer

Outbox persistence is disabled by default. Set both `AGY_OUTBOX_DIR` and `AGY_OUTBOX_OWNER` to enable it. A partial configuration is rejected.

Records contain the final answer, destination, public owner, delivery state and timestamps. They do not contain prompts, provider credentials, private keys or environment dumps. These files are not encrypted. POSIX mode 0700/0600 is requested; on Windows, filesystem ACLs determine effective access. Provision a private directory for the account running Buzz and verify those ACLs before enabling storage. POSIX mode bits alone do not prove Windows privacy.

```sh
agy-buzz-recover list
agy-buzz-recover show RECOVERY_ID
agy-buzz-recover retry RECOVERY_ID
```

The recovery command verifies the current public Buzz identity. `show` intentionally prints the retained answer. `retry` only accepts `failed-before-start` and claims the record before publishing. A stale retry lock remains blocked for operator reconciliation. It never retries `sent`, `uncertain`, or an interrupted publication blindly.

If an enabled outbox cannot write, the active adapter can retain a `mem_*` recovery ID in memory. That ID disappears when the adapter exits and cannot be recovered by a separate CLI process.

## Protocol boundaries

- Newline-delimited JSON-RPC 2.0 on stdio. Only protocol JSON is written to stdout.
- `initialize` accepts ACP protocolVersion 1 or 2 and negotiates stable v1 semantics.
- `session/new` requires an absolute working directory, creates an isolated session and advertises discovered model options when available.
- `session/set_config_option` accepts the model choice only before the first prompt, using an ID offered by that session.
- `session/prompt` accepts text blocks with a valid Buzz transport envelope. Both historical bracket markers and current XML markers are supported. The current Context block alone supplies the destination; duplicates and contradictory destinations are rejected before calling the provider.
- `session/cancel` interrupts provider/publication work without replaying the prompt.
- Images, audio, embedded context and bridging `mcpServers` are not supported. Provider-local tools remain governed by the provider's own configuration.

The adapter starts `agy` without a shell and always includes `--sandbox`. `--print-timeout 24h` is a process lifetime limit, not an idle timeout. Buzz's turn deadlines remain separate. No permission bypass flag is supported.

## Development and validation

```sh
npm test
npm run check
npm pack --dry-run
git diff --check
```

Tests use local fake provider/publisher processes and require no network or real credentials. Release verification should also extract the archive, run its commands, and test a synthetic real-provider conversation with a fake publisher. Confirm graphical Activity Log separately in the installed Buzz app; source-parser tests are not visual evidence.

See [compatibility and release checks](docs/COMPATIBILITY.md) and [contributing](CONTRIBUTING.md).

## Provider terms

Authentication remains entirely in the official CLI. This package neither extracts credentials nor grants permission to use any provider service. Consult the provider's current terms for your account and use case. There is no claim of Google endorsement or authorization.

## References

- [Antigravity headless CLI](https://antigravity.google/docs/cli/headless/)
- [Buzz custom harness documentation](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md)
- [Buzz's standalone-adapter guidance](https://github.com/block/buzz/issues/2393#issuecomment-5097071833)

MIT license. See [LICENSE](LICENSE).

## Operational diagnostics and upgrades

Use `agy-buzz-doctor --harness /path/to/harness.json --json` to inspect the configured installation and aggregate recovery state. The running version remains unknown unless independently observed; a configured path does not prove an existing process has reloaded it. The default diagnostic is offline. `--latest` explicitly queries the public release metadata, and `--models` explicitly queries the provider catalog. See [diagnostics](docs/DIAGNOSTICS.md).

Use `agy-buzz-manage` to plan a local archive installation or rollback. Supply the expected SHA-256 from a trusted release reference. Changes require `--apply`; the tool does not restart agents or refresh Desktop. See [upgrades and rollback](docs/UPGRADING.md).

See [recovery with official Buzz](docs/OFFICIAL_BUZZ_RECOVERY.md) for the native-lock design, forced-stop boundaries and migration requirements. Outbox recovery and conversation recovery remain separate mechanisms. Native dependencies are bundled in the release archive; do not copy only the JavaScript files when installing an extracted runtime.
