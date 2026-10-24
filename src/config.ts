import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PressureBasis } from "./pressure.ts";

export const CONFIG_NAME = "auto-handoff.json";

export interface HandoffSettings { idleMinutes: number; contextPercent: number; contextBasis: PressureBasis }
export type SettingKey = keyof HandoffSettings;
export type SettingSource = "flag" | "saved" | "default";

export const SETTINGS: Record<SettingKey, { flag: string; label: string; fallback: number | PressureBasis; max?: number }> = {
  idleMinutes: { flag: "handoff-idle-minutes", label: "Idle minutes", fallback: 50, max: 1_440 },
  contextPercent: { flag: "handoff-context-percent", label: "Context percent", fallback: 70, max: 100 },
  contextBasis: { flag: "handoff-context-basis", label: "Context basis", fallback: "window" },
};
const KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Validates one value from any source; throws a user-facing message. */
export function parseSetting(key: SettingKey, raw: unknown): number | PressureBasis {
  const spec = SETTINGS[key];
  if (key === "contextBasis") {
    if (raw !== "window" && raw !== "compaction") throw new Error(`${spec.label} must be window or compaction.`);
    return raw;
  }
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > spec.max!) throw new Error(`${spec.label} must be a number between 0 and ${spec.max}.`);
  return value;
}

const configPath = (agentDir: string) => join(agentDir, CONFIG_NAME);

function readSaved(agentDir: string): { values: Partial<HandoffSettings>; warning?: string } {
  let text: string;
  try { text = readFileSync(configPath(agentDir), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { values: {} };
    return { values: {}, warning: `Saved handoff settings unreadable; using defaults.` };
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { values: {}, warning: "Saved handoff settings are not valid JSON; using defaults." }; }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { values: {}, warning: "Saved handoff settings are invalid; using defaults." };
  const values: Partial<Record<SettingKey, unknown>> = {};
  const invalid: string[] = [];
  for (const key of KEYS) {
    if (!(key in data)) continue;
    try { values[key] = parseSetting(key, (data as Record<string, unknown>)[key]); } catch { invalid.push(key); }
  }
  return { values: values as Partial<HandoffSettings>, ...(invalid.length ? { warning: `Ignored invalid saved handoff settings: ${invalid.join(", ")}.` } : {}) };
}

/** Precedence: explicit CLI flag, then saved file, then built-in default. Invalid flags throw. */
export function resolveSettings(getFlag: (name: string) => unknown, agentDir = getAgentDir()) {
  const saved = readSaved(agentDir);
  const values = {} as Record<SettingKey, number | PressureBasis>;
  const sources = {} as Record<SettingKey, SettingSource>;
  for (const key of KEYS) {
    const raw = getFlag(SETTINGS[key].flag);
    if (raw !== undefined) {
      try { values[key] = parseSetting(key, raw); }
      catch (error) { throw new Error(`--${SETTINGS[key].flag}: ${(error as Error).message}`); }
      sources[key] = "flag";
    } else if (saved.values[key] !== undefined) { values[key] = saved.values[key]!; sources[key] = "saved"; }
    else { values[key] = SETTINGS[key].fallback; sources[key] = "default"; }
  }
  return { values: values as unknown as HandoffSettings, sources, warning: saved.warning };
}

/** Merges into the saved file with an atomic, private replace. */
export function saveSettings(update: Partial<HandoffSettings>, agentDir = getAgentDir()): Partial<HandoffSettings> {
  const next: Partial<HandoffSettings> = { ...readSaved(agentDir).values };
  for (const key of KEYS) if (update[key] !== undefined) (next as Record<string, unknown>)[key] = parseSetting(key, update[key]);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const path = configPath(agentDir);
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try { writeSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
  return next;
}

export function resetSettings(agentDir = getAgentDir()) { rmSync(configPath(agentDir), { force: true }); }

/** Parses `idle=30 percent=80 basis=compaction`. */
export function parseSetupArgs(text: string): Partial<HandoffSettings> {
  const aliases: Record<string, SettingKey> = { idle: "idleMinutes", percent: "contextPercent", basis: "contextBasis" };
  const update: Partial<Record<SettingKey, unknown>> = {};
  for (const part of text.split(/\s+/).filter(Boolean)) {
    const [name, value, extra] = part.split("=");
    const key = aliases[name ?? ""];
    if (!key || value === undefined || extra !== undefined) throw new Error("Use /handoff setup idle=<minutes> percent=<0-100> basis=window|compaction, or /handoff setup reset.");
    update[key] = parseSetting(key, value);
  }
  return update as Partial<HandoffSettings>;
}

export function describeSettings(resolved: ReturnType<typeof resolveSettings>): string {
  const lines = KEYS.map((key) => `${SETTINGS[key].label}: ${resolved.values[key]} (${resolved.sources[key]})`);
  if (resolved.warning) lines.push(resolved.warning);
  return lines.join("\n");
}
