# Contributing

Keep changes focused and write public documentation, comments, tests, diagnostics and activity labels with clear, consistent wording. Use Node.js 20-compatible APIs. The native file-lock dependency is an intentional exception to the minimal-dependency policy: persistence must not rely on a graceful Buzz shutdown. Avoid unrelated dependencies.

Run `npm test`, `npm run check`, and `git diff --check`. Add regression tests before behavioral fixes. Test provider integration with synthetic content and a fake publisher; do not send test messages to real channels without authorization.

Preserve these contracts: subprocesses run without a shell, provider sandbox remains enabled, destinations come from the current validated Buzz envelope, interrupted turns are never replayed, and ambiguous publication is never retried automatically.

Do not include credentials, conversation records, local paths, outbox contents, or private logs in issues or commits. Include OS, Node/Buzz/agy versions, a minimal synthetic reproduction, and sanitized error categories.

Discuss new persistence behavior or protocol changes in an issue first. A release needs independent review, package extraction checks and cross-platform fixture CI. Record real-provider validation separately from fixture tests.

Git attribution must identify the actual authors. Do not attribute agent-authored work to a human merely because they requested or approved it. Use a verified author identity; add co-authors only for material authorship.
