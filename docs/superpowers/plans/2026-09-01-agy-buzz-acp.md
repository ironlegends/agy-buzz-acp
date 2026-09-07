---
title: "Original agy Buzz ACP implementation plan"
tags: [buzz, acp, antigravity, plan]
status: superseded
created: 2026-09-01
---

# Original implementation record

This historical plan describes the original local prototype. The current README and release documentation supersede its scope and deployment restrictions.

1. Create an isolated repository branch.
2. Write native Node tests and a local fake agy process.
3. Observe the initial missing-binary failure before implementation.
4. Implement the dependency-free ACP JSON-RPC server, text parser and streaming agy session.
5. Map text deltas and terminal responses; support cancellation and deterministic errors.
6. Document MCP limitations and a custom harness example without changing the user's application data.
7. Validate the current Buzz transport envelope and publish the answer once through Buzz without a shell, retaining ACP chunks as transcript.
8. Run the full tests, package inspection, whitespace checks and Git status checks.

The initial phase did not publish a remote repository or activate a Buzz runtime. Later explicitly authorized work added outbox recovery, activity events, conversation recovery and portable distribution.
