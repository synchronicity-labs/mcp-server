# Claude upload card acceptance — 2026-10-15

Status: draft candidate; final live upload in Claude remains pending. No merge,
npm publication, production deployment, consent enablement, or directory submission
is authorized by this work.

## Immutable frontend

- Source PR: https://github.com/synchronicity-labs/sync-api-v2/pull/6876
- Source commit: `e9fae73d0782f97ee7b05c366897090761288957`
- Upload HTML SHA-256: `89517f0149c29f93ac66b2e4458de81f1184eadf6ceefae20d91f4a3f7107c5d`
- Upload HTML size: 2,261,862 bytes.
- Existing selected ChatGPT SHA-256 remains `670c3e5456b066ac7c184fde21dfe5c28fce284bae155992e38f0b8c61fed5b7`.

The separate uploader uses actual `@sync/ui` cards, buttons, progress, skeletons,
logo, Satoshi font and shared light/dark tokens. No new UI dependency was added.

## Verified

- 591 MCP tests in 44 files passed; focused server/profile/upload checks were
  repeated after the final instruction changes.
- Default and burst session-memory checks passed admission limits and recovery.
- The real browser-to-relay fixture upload test passed.
- SHA-256/provenance packaging verification passed for the uploader; existing
  ChatGPT release packaging also passed. npm dry-run includes the uploader HTML
  and manifest; no package was published.
- Uploader workspace typecheck/lint and seven targeted browser cases passed
  in 14 executions: audio/video/image save/readback/conversation receipt; organization-change refusal; uncertain
  registration without retry; message rejection retaining the asset; dark theme
  surviving a size-only host update.
- The broader 262-case local development/artifact run finished with 255 passed,
  four intentional skips and three failures. A frozen follow-up covering all
  three failures plus the uploader finished with 20 passed and four intentional
  skips; all ten uploader checks in that follow-up passed. The final 14-case uploader
  run also passed. Frontend CI is still being checked.
  The test-host context is supplied at construction, and uploader tests now
  reject unhandled page errors. These fixture fixes leave the UI HTML hash unchanged.
- Real Claude Web discovers the standalone interactive tool and renders its
  branded UI with the connected organization. Its observed client names are
  `Anthropic/Toolbox` and `Anthropic/ClaudeAI`; exact-name regression coverage was
  added. The full Claude app and ChatGPT attachment bridge remain separate.

## Remaining live acceptance

The in-app browser controls do not emit a chooser event from Claude's nested
sandbox. A plain nested native file input outside Claude reproduces the problem,
while the same branded input in a single-frame host works. This establishes an
automation limitation, not a successful live Claude upload. A person still needs
to select a short file in Claude and click upload; then verify its asset ID,
organization, media type, size, bytes, and conversation continuation.

The earlier plain upload prototype saved and read back a real 142,112-byte short
video with an exact byte/hash match. That proves the underlying relay/API path,
not the final branded card inside Claude. A loopback-only branded harness was
rejected before transfer because its relay destination used HTTP; the production
uploader correctly requires HTTPS. No paid provider operation was run for this
upload-card work.

## Release gates

Keep both standalone upload environment variables unset in production until user
approval and live acceptance. Before enabling, verify that `/app-upload` reaches
the instance that issued its one-use ticket, including during rollout/drain. Use
the exact public MCP URL to derive Claude's sandbox origin. Never broaden CORS to
wildcards. The full Claude app opt-in remains off.

The source PR and this stacked MCP PR remain draft while live acceptance is
incomplete. Existing release/consent/publishing gates from the Claude release
tracker still apply.
