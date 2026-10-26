import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Trigger } from "./handoff.ts";

export const MAX_DIAGNOSTIC_BYTES = 1_000_000;
export const DIAGNOSTIC_NAME = "diagnostics.jsonl";

/** One folder per project, named like Pi's own `sessions/<project>` folders; nothing is written into the project. */
export function diagnosticsDir(cwd: string, agentDir = getAgentDir()): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "auto-handoff", safe);
}

/** Removes one project's log, backup, and lock. */
export function clearDiagnostics(dir: string) {
  for (const name of [DIAGNOSTIC_NAME, `${DIAGNOSTIC_NAME}.1`, `${DIAGNOSTIC_NAME}.lock`]) rmSync(join(dir, name), { force: true });
  try { rmdirSync(dir); } catch {}
}
export type DiagnosticEvent = "start" | "retry" | "saved" | "failed" | "cancelled" | "skipped";
export type DiagnosticReason = "timeout" | "generation" | "persistence" | "session_changed" | "no_work" | "late_wake";
export interface Diagnostic {
  sessionId: string;
  event: DiagnosticEvent;
  reason?: DiagnosticReason;
  trigger?: Trigger;
  attempt?: number;
  durationMs?: number;
  evidenceChars?: number;
  truncated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}
const EVENTS: readonly string[] = ["start", "retry", "saved", "failed", "cancelled", "skipped"];
const REASONS: readonly string[] = ["timeout", "generation", "persistence", "session_changed", "no_work", "late_wake"];

/** Explicit allowlist: never serialize caller objects, errors, evidence, or paths. */
export function diagnosticRecord(value: Diagnostic) {
  const record: Record<string, unknown> = { version: 1, at: new Date().toISOString(),
    sessionId: /^[\w-]{1,80}$/.test(value.sessionId) ? value.sessionId : "unknown",
    event: EVENTS.includes(value.event) ? value.event : "failed" };
  if (value.reason && REASONS.includes(value.reason)) record.reason = value.reason;
  if (value.trigger && ["idle", "pressure", "manual"].includes(value.trigger)) record.trigger = value.trigger;
  if (typeof value.truncated === "boolean") record.truncated = value.truncated;
  for (const key of ["attempt", "durationMs", "evidenceChars", "inputTokens", "outputTokens", "cost"] as const) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) record[key] = number;
  }
  return record;
}

/** One bounded backup; non-blocking cross-process lock. Abandoned locks older than 30 seconds are reclaimed once. */
export function createDiagnostics(dir: string, maxBytes = MAX_DIAGNOSTIC_BYTES) {
  const path = join(dir, DIAGNOSTIC_NAME);
  const lock = `${path}.lock`;
  let availability = "not yet attempted";
  return {
    status: () => `Diagnostics: ${availability}; ${path} (metadata only).`,
    append(value: Diagnostic): boolean {
      let lockFd: number | undefined;
      let fd: number | undefined;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { lockFd = openSync(lock, "wx", 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - statSync(lock).mtimeMs <= 30_000) throw error;
          // No waiting: reclaim an abandoned writer, then retry exclusive creation once.
          unlinkSync(lock);
          lockFd = openSync(lock, "wx", 0o600);
        }
        const line = `${JSON.stringify(diagnosticRecord(value))}\n`;
        if (Buffer.byteLength(line) > maxBytes) throw new Error("diagnostic record exceeds cap");
        fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        if (!fstatSync(fd).isFile()) throw new Error("not a regular diagnostic file");
        fchmodSync(fd, 0o600);
        if (fstatSync(fd).size + Buffer.byteLength(line) > maxBytes) {
          closeSync(fd); fd = undefined;
          renameSync(path, `${path}.1`);
          fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          fchmodSync(fd, 0o600);
        }
        writeSync(fd, line);
        availability = "available";
        return true;
      } catch {
        availability = "unavailable or busy (records may be dropped)";
        return false;
      } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        if (lockFd !== undefined) {
          try { closeSync(lockFd); } catch {}
          try { unlinkSync(lock); } catch {}
        }
      }
    },
  };
}
