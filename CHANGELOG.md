# Changelog

## 0.3.0 - 2026-10-24

- Add `/handoff setup` (interactive picker, or `idle=`/`percent=`/`basis=` arguments and `reset`) to save automatic-checkpoint settings in `auto-handoff.json`. CLI flags still take precedence; `/handoff status` shows each value's source.
- Make the metadata diagnostics log opt-in (`/handoff setup diagnostics=on` or `--handoff-diagnostics on`); by default nothing is written.
- Store diagnostics per project at `~/.pi/agent/auto-handoff/<project>/diagnostics.jsonl`, each with its own 1 MB cap; add `/handoff setup clear-logs`. The old shared `~/.pi/agent/auto-handoff.jsonl` is no longer used and can be deleted.

## 0.2.0 - 2026-10-24

- Preserve head and tail evidence with provenance labels, consistent handoff section instructions, and bounded recorded file-operation lists.
- Carry each continued session's inherited handoff into its next checkpoint as the previous handoff, so goals and user constraints survive successive continuations.
- Add read-only, paginated `handoff_history` recovery restricted to the linked parent's saved source branch.
- Add opt-in `--handoff-context-basis compaction` using file-backed settings; preserve existing window-percent defaults.
- Render saved checkpoint cards with expanded Markdown and enrich `/handoff status` with usage, pressure policy, and diagnostics; direct users to status for freshness.
- Cache file-backed compaction policy until settings metadata or model/project identity changes, avoiding repeated settings locks after every turn.
- Keep file-list truncation separate from source evidence/output truncation.
- Record bounded, metadata-only lifecycle diagnostics without blocking checkpoint operations; reclaim abandoned lock files after 30 seconds.
- Run type checks and tests in GitHub Actions on Node.js 22.19 and the current LTS.

## 0.1.1 - 2026-10-13

- Increase the checkpoint generation timeout from 40 to 120 seconds.
- Retry a local timeout once after 5 seconds when the first request has stopped and the session remains idle and unchanged.
- Cancel recovery on new input or session/model changes, and prevent overlapping requests and late checkpoint saves.

## 0.1.0 - 2026-10-06

- Initial release with automatic checkpoints after inactivity or high estimated context use.
- `/handoff`, `/handoff status`, and `/handoff continue` commands.
- Native session storage and linked fresh-session continuation.
- Configurable idle and context thresholds.
- Bounded generation, cancellation, stale-note refresh, and failure handling.
