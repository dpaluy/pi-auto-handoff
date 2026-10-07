---
shaping: true
---

# pi-auto-handoff shaping

## Source

> I want to create a new pi extension `pi-auto-handoff`
> Let's do shaping of it (delegate explore work to subagents)
>
> references:
> - @/Users/dpaluy/projects/ai/pi/pi-you-should-know/ - my other extension
> - https://github.com/obie/auto-handoff idea inspiration implemented for Claude Code

The initial question was whether the core goal was an idle work checkpoint, a context-limit handoff, or both.

> Q1: Both

Additional reference supplied by the user:

> /Users/dpaluy/projects/ai/skills/majestic-skills/abilities has also handoff skill I created previously

The user clarified its role:

> no, it's for reference only

## Problem and outcome

Confirmed scope: preserve useful work after inactivity and support continuation in fresh context when a session gets large.

A handoff must preserve enough information to continue without repeating investigation or losing constraints. Saving a note, creating a fresh session, and starting work in that session are separate actions. Permission for one does not imply permission for the others.

Shape D's Pi-native architecture is selected. The user approved native lifecycle handling, estimated context measurement, active-branch capture, native session persistence, and command-based continuation, then requested implementation. Implementation is complete with the policies below. No publication, installation into the user's active Pi configuration, or production action was requested.

## Evidence

- **F1:** The reference arms a timer after main-turn completion, defaults to 50 minutes, and requests a handoff once per absence. It does not clear context, create a new session, or import a handoff. Its cache-expiry check is a time heuristic, not an observed cache state. [Reference hooks](https://github.com/obie/auto-handoff/blob/19405aa47bcb31ef775a427a7118f9519ea21734/hooks/register.ts).
- **F2:** Installed Pi 1.0.4 exposes context-use estimates and command-only session replacement. Lifecycle handlers cannot safely use command session controls. `newSession` supports parent linkage and a fresh `withSession` context. Unknown context use is a supported state. Sources: installed `docs/extensions.md`, `dist/core/extensions/types.d.ts:197-339`.
- **F3:** Pi has provider-aware cache warming. Idle checkpointing must not claim cache savings based on the reference's fixed 50-minute interval. Sources: installed `docs/settings.md`, `docs/models.md`.
- **F4:** `pi-you-should-know` supplies package metadata, native model calls, cancellation, branch invalidation, and behavioral tests. It has no background or compaction integration to reuse. Sources: sibling `package.json`, `src/index.ts`, `src/briefing.ts`, and `test/observer.test.ts`.

- **F5:** The user's existing `session-handoff` skill defines a harness-independent Prepare/Resume protocol, `handoff/v1` schema, stable task chains, immutable transfer history, atomic latest-file replacement, and repository drift checks. It permits unattended preparation and makes lifecycle controls the host's responsibility. Sources: `/Users/dpaluy/projects/ai/skills/majestic-skills/abilities/plugins/core/skills/session-handoff/SKILL.md` and `references/handoff-format.md`.

Initial exploration used static inspection. Implementation verification now includes the native extension loader, persisted sessions, and a real Pi runtime session transition using a local model fixture. No paid-provider generation test has run.

Pi sources are under `/Users/dpaluy/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/`. Pi 1.0.4 is the tested development version. Older versions are not verified.

## Existing skill as reference only

The user's `session-handoff` skill is reference material, not a selected protocol or dependency. Do not adopt its schema, task-chain identifiers, history layout, storage convention, pressure thresholds, or path-based resume instructions by default.

Useful design lessons to consider independently: distinguish verified facts from hypotheses, record only checks that ran, expose incomplete work, preserve one concrete next action, save safely, and check current state before continuation. These remain design inputs, not additional confirmed requirements.

Pi's context-use API provides estimates. Describe them as estimates rather than exact telemetry. Native session-entry storage is selected. The extension uses its own small versioned payload, injects the note into the linked fresh session, and starts continuation immediately. Its pressure default is 70%; that is an extension policy, not adoption of the skill protocol.

## Requirements

| ID | Requirement | Status |
|---|---|---|
| R0 | Support both an idle work checkpoint and continuation in fresh context for large sessions. | Core goal, confirmed |
| R1 | Preserve the task, user constraints, decisions, relevant files, last-known verification, blockers, and next steps. | Proposed must-have |
| R2 | Do not interrupt active work, discard queued input, or publish a note from an abandoned session or branch. | Must-have, approved |
| R3 | Keep the source session and a usable saved handoff if continuation fails or is canceled. | Proposed must-have |
| R4 | Bound automatic model work and prevent checkpoint requests from triggering repeated checkpoint generation. | Proposed must-have |
| R5 | Leave native compaction and cache warming functional without changing the user's settings. | Must-have, approved |
| R6 | Create the fresh session and start continuation without a user command. | Out |

## Earlier options

- **A: Idle work checkpoint.** Covers inactivity only.
- **B: Context-limit handoff.** Covers large sessions only, with a user command for replacement.
- **C: Manual handoff.** Creates notes only on demand.

Q1 rules out A, B, or C alone. The combined options below retain both automatic triggers. A manual command can be an affordance within either option, not a competing goal.

## D: Automatic preparation, explicit continuation

Selected architecture: D combines the idle trigger from A and the context trigger and command-based continuation from B. Persist handoffs as native Pi session entries, not project files.

| Part | Implemented mechanism | Limit |
|---|---|---|
| D1 | Observe notification-only `agent_settled` and check estimated context use in a timer after dispatch. Recheck idle state, queued input, session, and branch before saving. Invalidate work on input, agent start, compaction, model/branch/session changes, and shutdown. | Automatic work runs only in TUI/RPC with persistent sessions. Native compaction can run first. |
| D2 | Generate without tools using the active model. Use a compaction-aware projection of the active branch, respecting context edits. Cap evidence at 48,000 characters, with smaller limits for small windows, and previous-note context at 8000 additional characters. Prioritize the first request and user/summary text. Limit output to 2048 tokens, with zero provider retries and a 40-second timeout. | Truncation is explicit. Thinking and image content are omitted. Summary quality and secret removal are not guaranteed. |
| D3 | Store a version-1 `pi-auto-handoff` custom entry with identity, source session/entry, time, trigger, model, text, truncation flag, and usage. Select notes only from the active branch. Catch save errors and exclude failed entries from reuse. | Ephemeral sessions cannot prepare or continue. Uses normal Pi persistence, not a crash-atomic transfer transaction. Standalone generation usage is recorded but not added to native totals. |
| D4 | Expose `/handoff`, `/handoff status`, and `/handoff continue`. Reuse a current note or refresh one after model-visible branch state advances. | Branch freshness does not detect external filesystem changes. |
| D5 | Wait for idle, reject queued input, capture plain transfer data, and call `newSession` with parent linkage. Initialize a model-visible custom message in `setup`; send the immediate continuation request through fresh `withSession` context. Preserve the source note on cancellation or failure. | No automatic replacement. Continuation asks the model to verify current files; it does not restore live tool or process state. |
| D6 | Default to 50 idle minutes and 70% estimated context use, configurable through native CLI flags; 0 disables either trigger. Attempt once per absence or high-context episode and reuse current notes. Reset idle eligibility on returned input; reset pressure eligibility on observed lower context or model/session/branch change. Skip idle calls more than 10% late. | Timers and attempt state are ephemeral. No startup catch-up timer; next settlement starts observation again. No background retry loop. |

D does not cancel native compaction. If Pi compacts before a checkpoint can be prepared, retain that summary as input and reevaluate at a safe boundary. It does not promise that an extension can always save the full pre-compaction context at a custom threshold.

## E: Automatic preparation and session replacement (not selected)

E uses D1-D3 and D6, but replaces D4-D5 with automatic session creation and continuation after a context checkpoint succeeds. An idle checkpoint saves a note without starting unattended task work.

| Part | Mechanism | Open mechanism |
|---|---|---|
| E1 | Use D1-D3 and D6 for triggers, generation, saving, and suppression. | Inherits D's unresolved details. |
| E2 | After a context checkpoint is saved, create a linked fresh session and initialize continuation without user input. | No safe event-to-session-replacement mechanism has been established. Installed Pi documents session replacement as command-only. |
| E3 | Recover from cancellation or a partial transition without duplicate task execution or lost queued input. | Depends on resolving E2 and validating transition failure behavior. |

Do not cast an event context to a command context, retain an old command context for timer use, or inject a slash command and assume it is a supported session-control scheduler. E needs a supported mechanism before it can be selected.

## Fit check: selected D

Pass means the approach addresses the requirement, not that runtime verification passed. Fail means a missing mechanism or deliberate mismatch.

| Req | Requirement | Status | D |
|---|---|---|---|
| R0 | Support both an idle work checkpoint and continuation in fresh context for large sessions. | Core goal, confirmed | Pass |
| R1 | Preserve the task, user constraints, decisions, relevant files, last-known verification, blockers, and next steps. | Proposed must-have | Pass |
| R2 | Do not interrupt active work, discard queued input, or publish a note from an abandoned session or branch. | Must-have, approved | Pass |
| R3 | Keep the source session and a usable saved handoff if continuation fails or is canceled. | Proposed must-have | Pass |
| R4 | Bound automatic model work and prevent checkpoint requests from triggering repeated checkpoint generation. | Proposed must-have | Pass |
| R5 | Leave native compaction and cache warming functional without changing the user's settings. | Must-have, approved | Pass |
| R6 | Create the fresh session and start continuation without a user command. | Out | Fail |

Notes:
- R1 has a bounded generation/preservation mechanism, not a proof of semantic completeness. Real model quality is unverified.
- R3 covers tested save failure and transition cancellation/failure. Process-crash durability is limited to normal Pi persistence.
- D deliberately fails R6, which is Out and not a selection blocker.

## Detail D: breadboard

These tables map the implemented flow. Place IDs below are local to this breadboard.

### Places

| ID | Place | Description |
|---|---|---|
| BB1 | Source Pi session | Normal conversation, checkpoint status, and commands |
| BB2 | Linked fresh Pi session | Continuation initialized from a captured handoff |

### UI affordances

| ID | Place | Affordance | Control | Wires Out | Returns To |
|---|---|---|---|---|---|
| U1 | BB1 | `/handoff` | Command | N3 | None |
| U2 | BB1 | `/handoff continue` | Command | N5 | None |
| U3 | BB1 | Preparing, saved, stale, or failed status | Display | None | None |
| U4 | BB2 | Loaded handoff and continuation status | Display | None | None |

### Code affordances

| ID | Place | Affordance | Control | Wires Out | Returns To |
|---|---|---|---|---|---|
| N1 | BB1 | Settlement observer and scheduled eligibility checks | Observe `agent_settled`; act after dispatch or on timer expiry | N3 after dispatch, S2 | None |
| N2 | BB1 | Input, branch, session, and shutdown invalidation | Lifecycle or input event | S2, U3 | None |
| N3 | BB1 | Preparation handler: check eligibility, capture active branch, run bounded tool-free generation | N1 or U1 | S2, N4, U3 | N5 when refreshing a stale note |
| N4 | BB1 | Snapshot validation and completed-handoff append | Generation completes | S1, S2, U3 | N3 |
| N5 | BB1 | Continuation command: wait for idle, check queued input, select or refresh note, capture plain transfer data | U2 | N3 when needed, BB2 on successful `newSession`, U3 on cancellation/failure | None |
| N6 | BB2 | Initialize captured handoff in new-session setup; send immediate resume request through fresh context | `setup`, then `withSession` | S3, U4 | N5 for success/failure reporting |
| N7 | BB1 | Active-branch handoff reconstruction | Session load or branch change | S2, U3 | N5 |

### Stores

| ID | Place | Store | Written by | Returns To |
|---|---|---|---|---|
| S1 | BB1 | Native custom entries containing completed notes and source metadata | N4 through `pi.appendEntry` | N7, N5 through active-branch reads |
| S2 | BB1 | Ephemeral timer, cancellation generation, current operation, and checkpoint eligibility | N1, N2, N3, N4, N7 | N1, N3, N5, U3 |
| S3 | BB2 | New session's model-visible handoff and resume request | N6 through setup and fresh context | Native next model request, U4 |

The source session remains available through parent linkage. Its saved note is not injected into its model context. Native compaction and warming remain controlled by existing Pi settings.

## Decisions and verification

- **Q2 resolved:** Explicit command-based continuation, Shape D. No automatic session replacement.
- **Q3 resolved:** Pi-native session entries. The existing skill remains reference only.
- **Q4 resolved for implementation:** 50 minutes idle, 70% estimated context use, native flags for adjustment/disable, active-model tool-free generation, and the budgets and suppression rules in D2/D6. The idle threshold makes no claim about cache expiry or savings.
- **Q5 resolved for implementation:** `/handoff continue` immediately starts the next model turn, consistent with the recommended command behavior.

`npm run check` and all 21 tests passed. Tests use disposable fixtures and include actual native loader, persistence, and a Pi runtime flow that saves the source note, replaces the session, and executes a local-fixture continuation. No product publication or install into the user's active Pi configuration was performed.

Remaining limits: no paid-provider summary-quality validation, no guaranteed secret redaction, no exact context telemetry, no external-file freshness guarantee, and no atomic cross-session crash recovery.
