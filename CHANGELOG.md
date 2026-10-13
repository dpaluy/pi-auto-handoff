# Changelog

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
