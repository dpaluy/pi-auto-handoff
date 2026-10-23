import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ENTRY_TYPE } from "./handoff.ts";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const clean = (value: unknown, limit: number): string => typeof value === "string"
  ? value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, limit) : "unknown";
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function usageLabel(value: unknown): string {
  const usage = object(value);
  const input = number(usage?.input);
  const output = number(usage?.output);
  const cost = number(object(usage?.cost)?.total);
  return [input === undefined ? undefined : `${input} input tokens`, output === undefined ? undefined : `${output} output tokens`,
    cost === undefined ? undefined : `$${cost.toFixed(4)}`].filter(Boolean).join(" · ") || "usage unavailable";
}

export function checkpointLabel(value: unknown): string {
  const note = object(value);
  return `${clean(note?.createdAt, 40)} · ${clean(note?.trigger, 20)} · ${clean(note?.model, 160)} · ${note?.truncated === true ? "truncated evidence" : "evidence not marked truncated"} · ${usageLabel(note?.usage)}`;
}

export function registerHandoffDisplay(pi: ExtensionAPI) {
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const note = object(entry.data);
    if (!note || note.version !== 1 || typeof note.text !== "string") return undefined;
    const heading = theme.fg("accent", "Handoff saved");
    const label = theme.fg(note.truncated === true ? "warning" : "muted", checkpointLabel(note));
    // Stateless theme callback; Text provides native wrapping including narrow terminal widths.
    return new Text(`${heading}\n${label}${expanded ? `\n\n${clean(note.text, 20_100)}` : "\nExpand for checkpoint details. /handoff continue"}`, 0, 0);
  });
}
