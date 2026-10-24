# pi-auto-handoff

Version **0.3.0**. [Changelog](CHANGELOG.md).

Save work checkpoints after inactivity or high context use. Continue in a linked fresh Pi session when ready.

![Handoff loaded in a linked fresh Pi session (offline demo)](handoff-preview.png)

## Install

Requires Pi 1.0.4 or later and Node.js 22.19 or later.

```sh
pi install npm:pi-auto-handoff
```

Or install from GitHub:

```sh
pi install git:github.com/dpaluy/pi-auto-handoff
```

Restart Pi or run `/reload`.

## Use

| Command | Action |
|---|---|
| `/handoff` | Save a checkpoint. |
| `/handoff status` | Show checkpoint status. |
| `/handoff continue` | Refresh if needed, start a linked fresh session, and continue immediately. |
| `/handoff setup` | Choose and save automatic-checkpoint settings. |

Checkpoints are saved in Pi's session file, not project files. The original session remains available through `/resume`. Native compaction and cache warming are unchanged. Compatibility with other compaction-policy extensions has not been integration-tested.

Saved checkpoints have an expandable card showing their trigger, model, evidence truncation, and available usage/cost. `/handoff status` also reports freshness, pressure policy, and diagnostic availability.

## Evidence and recovery

Checkpoint evidence keeps the beginning and end of long outputs, with explicit omission markers. User messages, coordination messages, generated summaries, and tool/shell evidence retain distinct labels. The prompt requests consistent sections for goals, constraints, state, decisions, files, verification, blockers, and next action; model formatting is not schema-validated.

Bounded recorded file-operation lists are carried forward separately from the generated text. They describe recorded calls and native lists, **not proof of successful writes or current file state**. File-list truncation is marked in that list separately from evidence or generated-text truncation.

After `/handoff continue`, the model can use `handoff_history` to search case-insensitive literal text and read entries from the linked parent's saved source branch. It cannot choose arbitrary files, sibling branches, later parent activity, or other sessions. Reads honor context edits and omissions and exclude thinking, system content, images, and opaque metadata. Results are capped at 8,000 characters with pagination. Parent files are streamed one JSON line at a time and privacy-filtered before retention; large inline images no longer count toward a raw file-size cap. Retained content is capped at 16 Mi characters, including structural metadata, with a clear failure if exceeded. One raw JSON line must still fit in memory while parsing. Validated source-branch records are cached until the parent path, size, modification time, or checkpoint identity changes. Native session format v3 is required. Missing or invalid linkage fails closed; locally tampered session files are not authenticated.

## Automatic checkpoints

Defaults: **50 idle minutes** or **70% estimated context use**. Automatic checkpoints run in TUI and RPC modes with saved sessions. Session replacement always requires `/handoff continue`.

Change and save thresholds with `/handoff setup`, which opens a picker in the TUI. Or pass values directly (works in RPC mode too):

```sh
/handoff setup idle=30 percent=80 basis=compaction
/handoff setup reset
```

Saved settings live in `~/.pi/agent/auto-handoff.json` (private permissions, replaced atomically) and apply immediately. Pi's own `settings.json` is not touched. An invalid saved value is ignored with a warning in `/handoff status`, which also shows where each value came from (`flag`, `saved`, or `default`).

Flags override saved settings for one launch:

```sh
pi --handoff-idle-minutes 30 --handoff-context-percent 80
```

Set either value to `0` to disable that trigger.

By default, the percentage is measured against the whole context window. To checkpoint at a percentage of the configured compaction budget instead:

```sh
pi --handoff-context-basis compaction --handoff-context-percent 70
```

This uses `70% × (context window − compaction.reserveTokens)` from file-backed Pi settings, including model overrides and trusted-project settings. The resolved policy is cached until settings file metadata, model, project trust, or settings location changes. Settings content is never modified, but Pi's settings loader acquires temporary lock files when reading on a cache miss. Pi 1.0.4 does not expose SDK in-memory overrides here, so this is not an authoritative runtime budget. If configured compaction is disabled, it falls back to the window basis. Unknown usage, invalid budgets, or unreadable settings suppress the compaction-basis pressure trigger; status explains why. Use `--handoff-context-basis window` for the default behavior.

Each checkpoint request has a **120-second timeout**. On timeout, the extension aborts the request and retries **once after 5 seconds**, only if the first request has stopped and the session is still idle and unchanged. New input or session/model changes cancel recovery. If the provider does not stop during backoff, recovery fails without starting another request; later attempts stay blocked until it stops. Other failures are not retried.

## Privacy

Checkpoint generation sends bounded session text to the active model provider. Provider charges or subscription limits can apply. Notes and retrieved history can contain sensitive information; secret removal is not guaranteed. Retrieved history enters the continuing model's context.

Best-effort diagnostic metadata is stored at Pi's agent directory (`~/.pi/agent/auto-handoff.jsonl` by default), capped at 1 MB plus one rotated backup. It records checkpoint outcomes, timing, truncation, and available usage—not evidence, note text, file paths, or raw errors. Files use private permissions. Contention or write failures may drop records but never prevent checkpointing. A `.lock` file left by a crash is reclaimed on a later append once it is older than 30 seconds; fresh locks still cause records to be dropped rather than waiting.

## License

[MIT](LICENSE.txt)

Supported by [Majestic Labs](https://majesticlabs.dev/).
