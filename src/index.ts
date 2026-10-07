import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE, generateHandoff, latestHandoff, REQUEST_TIMEOUT_MS, snapshot, sourceEntryId, type Handoff, type Trigger } from "./handoff.ts";

const STATUS_KEY = "auto-handoff";

export default function autoHandoff(pi: ExtensionAPI) {
  pi.registerFlag("handoff-idle-minutes", { type: "string", default: "50", description: "Idle checkpoint delay (0 disables; default 50 minutes)" });
  pi.registerFlag("handoff-context-percent", { type: "string", default: "70", description: "Estimated context checkpoint threshold (0 disables; default 70 percent)" });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let epoch = 0;
  let pressureAttempted = false;
  let idleAttempted = false;
  let commandBusy = false;
  const failedNotes = new Set<string>();
  const status = (ctx: ExtensionContext, text: string | undefined) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text ? `Handoff: ${text}` : undefined);
  };
  const report = (ctx: ExtensionContext, text: string, error = false) => {
    status(ctx, error ? "failed; /handoff to retry" : text);
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
  };
  const cancel = () => {
    epoch++;
    clearTimeout(timer); timer = undefined;
    request?.abort(); request = undefined;
  };
  const numberFlag = (name: string, max: number) => {
    const raw = pi.getFlag(name);
    const value = Number(raw);
    if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(value) || value < 0 || value > max) {
      throw new Error(`--${name} must be a number between 0 and ${max}.`);
    }
    return value;
  };
  const saved = (ctx: ExtensionContext) => latestHandoff(ctx.sessionManager.getBranch(), failedNotes);
  const current = (ctx: ExtensionContext, note: Handoff) => note.sessionId === ctx.sessionManager.getSessionId()
    && note.sourceEntryId === sourceEntryId(ctx.sessionManager.getBranch());
  const eligible = (ctx: ExtensionContext) => ctx.isIdle() && !ctx.hasPendingMessages()
    && !!ctx.sessionManager.getSessionFile();

  async function prepare(ctx: ExtensionContext, trigger: Trigger): Promise<Handoff | undefined> {
    if (!eligible(ctx)) throw new Error("Handoff requires an idle, saved session with no queued input.");
    const existing = saved(ctx);
    if (existing && current(ctx, existing)) return existing;
    const captured = snapshot(ctx);
    if (!captured.hasWork || !captured.sourceEntryId) { report(ctx, "No work to hand off."); return; }
    cancel();
    const lifetime = epoch;
    const controller = new AbortController();
    request = controller;
    status(ctx, "preparing");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Handoff canceled because the session changed."));
      controller.signal.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        reject(new Error("Handoff timed out after 40 seconds. Retry with /handoff."));
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      timeout.unref();
    });
    let note: Handoff | undefined;
    try {
      note = await Promise.race([generateHandoff(ctx, captured, trigger, controller.signal, existing), stopped]);
      if (lifetime !== epoch || !eligible(ctx) || ctx.sessionManager.getSessionId() !== captured.sessionId
        || ctx.sessionManager.getLeafId() !== captured.leafId) return;
      try { pi.appendEntry(ENTRY_TYPE, note); }
      catch (error) { failedNotes.add(note.id); throw error; }
      report(ctx, "Saved; /handoff continue");
      return note;
    } catch (error) {
      if (lifetime !== epoch) return;
      if (note) throw new Error("Handoff could not be saved. The source session was not replaced.");
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      controller.abort();
      if (request === controller) request = undefined;
    }
  }

  // A timer runs after the notification-only settlement handler has returned.
  const schedule = (ctx: ExtensionContext) => {
    clearTimeout(timer);
    if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !eligible(ctx) || commandBusy) return;
    const lifetime = epoch;
    timer = setTimeout(() => {
      timer = undefined;
      if (lifetime !== epoch || !eligible(ctx) || commandBusy) return;
      try {
        const threshold = numberFlag("handoff-context-percent", 100);
        const minutes = numberFlag("handoff-idle-minutes", 1_440);
        const percent = ctx.getContextUsage()?.percent;
        const high = threshold > 0 && percent != null && Number.isFinite(percent) && percent >= threshold;
        if (!high) pressureAttempted = false;
        const note = saved(ctx);
        if (note && current(ctx, note)) { status(ctx, "saved; /handoff continue"); return; }
        const automatic = (trigger: Trigger) => {
          const task = prepare(ctx, trigger);
          const started = epoch;
          void task.catch((error: unknown) => {
            if (started === epoch) report(ctx, error instanceof Error && error.message.startsWith("Handoff")
              ? error.message : "Handoff request failed. Check the active model and retry with /handoff.", true);
          });
        };
        if (high && !pressureAttempted) {
          pressureAttempted = true;
          automatic("pressure");
        } else if (minutes > 0 && !idleAttempted) {
          const wait = minutes * 60_000;
          const due = Date.now() + wait;
          timer = setTimeout(() => {
            timer = undefined;
            if (lifetime !== epoch || !eligible(ctx) || commandBusy) return;
            idleAttempted = true;
            if (Date.now() > due + wait * 0.1) { status(ctx, "idle checkpoint skipped after late wake"); return; }
            automatic("idle");
          }, wait);
          timer.unref();
        }
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : "Invalid handoff flags.", true);
      }
    }, 0);
    timer.unref();
  };

  async function continueSession(ctx: ExtensionCommandContext, note: Handoff) {
    if (!eligible(ctx) || !current(ctx, note)) throw new Error("Handoff is stale or input is queued. Retry after the agent settles.");
    const parentSession = ctx.sessionManager.getSessionFile()!;
    const transfer = { ...note };
    let fresh: Pick<ExtensionContext, "ui"> | undefined;
    try {
      const result = await ctx.newSession({
        parentSession,
        setup: async (manager) => {
          manager.appendCustomMessageEntry("pi-auto-handoff-context", transfer.text, true, {
            sourceSession: transfer.sessionId, sourceEntryId: transfer.sourceEntryId, handoffId: transfer.id,
          });
        },
        withSession: async (next) => {
          fresh = next;
          next.ui.notify("Handoff loaded. Continuing in a linked fresh session.", "info");
          await next.sendUserMessage("Continue from the saved handoff above. Check the relevant current files before changing them. Report only material drift or blockers, then carry out its next action. Do not repeat completed work or invent work if the task is complete.");
        },
      });
      // Successful replacement invalidates ctx and pi. Do no source-context work afterward.
      if (result.cancelled) report(ctx, "Session change canceled. The handoff remains saved.");
    } catch {
      if (fresh) fresh.ui.notify(`Continuation failed. The saved handoff remains in ${parentSession}. Resume the source session to retry.`, "error");
      else {
        // Replacement might already have invalidated ctx before withSession could run.
        throw new Error(`Session replacement failed. The saved handoff remains in ${parentSession}.`);
      }
    }
  }

  pi.registerCommand("handoff", {
    description: "Save a checkpoint, show status, or continue in a linked fresh session",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!["", "continue", "status"].includes(action)) { report(ctx, "Use /handoff, /handoff status, or /handoff continue."); return; }
      if (action === "status") {
        const note = saved(ctx);
        report(ctx, request ? "Preparing handoff." : note
          ? `Last handoff: ${note.createdAt} (${current(ctx, note) ? "current" : "stale"}). /handoff continue refreshes stale notes.`
          : "No saved handoff on this branch.");
        return;
      }
      if (commandBusy) { report(ctx, "A handoff command is already running."); return; }
      commandBusy = true;
      cancel();
      const lifetime = epoch;
      try {
        await ctx.waitForIdle();
        if (lifetime !== epoch) return;
        const note = await prepare(ctx, "manual");
        if (note && action === "continue") await continueSession(ctx, note);
      } catch (error) {
        // newSession can invalidate the source API. Let Pi report transition errors instead.
        if (error instanceof Error && error.message.startsWith("Session replacement failed")) throw error;
        report(ctx, error instanceof Error && error.message.startsWith("Handoff")
          ? error.message : "Handoff request failed. Check the active model and retry with /handoff.", true);
      } finally { commandBusy = false; }
    },
  });

  pi.on("agent_settled", (_event, ctx) => schedule(ctx));
  pi.on("input", (_event, ctx) => { cancel(); idleAttempted = false; status(ctx, saved(ctx) ? "stale; /handoff to refresh" : undefined); });
  pi.on("agent_start", (_event, ctx) => { cancel(); idleAttempted = false; status(ctx, saved(ctx) ? "stale; /handoff to refresh" : undefined); });
  pi.on("model_select", (_event, ctx) => { cancel(); pressureAttempted = false; status(ctx, undefined); });
  pi.on("user_bash", (_event, ctx) => { cancel(); idleAttempted = false; status(ctx, undefined); });
  pi.on("session_before_compact", (_event, ctx) => { cancel(); status(ctx, undefined); });
  pi.on("session_before_tree", () => cancel());
  pi.on("session_tree", (_event, ctx) => { cancel(); pressureAttempted = false; idleAttempted = false; status(ctx, saved(ctx) ? "saved; freshness checked on continue" : undefined); });
  pi.on("session_start", (_event, ctx) => { cancel(); pressureAttempted = false; idleAttempted = false; failedNotes.clear(); status(ctx, saved(ctx) ? "saved; freshness checked on continue" : undefined); });
  pi.on("session_shutdown", (_event, ctx) => { cancel(); status(ctx, undefined); });
}
