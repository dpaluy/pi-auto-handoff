# Changelog

## Unreleased

- Preserve head and tail evidence with provenance labels, consistent handoff section instructions, and bounded recorded file-operation lists.
- Add read-only, paginated `handoff_history` recovery restricted to the linked parent's saved source branch.
- Add opt-in `--handoff-context-basis compaction` using file-backed settings; preserve existing window-percent defaults.
- Render saved checkpoint cards and enrich `/handoff status` with usage, pressure policy, and diagnostics.
- Record bounded, metadata-only lifecycle diagnostics without blocking checkpoint operations.

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
