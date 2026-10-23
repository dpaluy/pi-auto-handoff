import { buildSessionProjection, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";

export interface RecordedFiles {
  read: string[];
  modified: string[];
  truncated: boolean;
}
export const MAX_FILE_PATH_CHARS = 300;
export const MAX_FILE_COUNT = 60;
export const MAX_FILE_CHARS = 3_000;

/** Keep useful conclusions at the end of logs, within the caller's full character budget. */
export function excerpt(text: string, limit: number): string {
  limit = Math.max(0, Math.floor(limit));
  if (text.length <= limit) return text;
  const marker = "\n[content truncated; middle omitted]\n";
  if (limit < marker.length + 2) return "[truncated]".slice(0, limit);
  const head = Math.ceil((limit - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(text.length - (limit - marker.length - head));
}

export function validRecordedFiles(value: unknown): value is RecordedFiles {
  if (!value || typeof value !== "object") return false;
  const files = value as RecordedFiles;
  if (!Array.isArray(files.read) || !Array.isArray(files.modified) || typeof files.truncated !== "boolean") return false;
  const all: unknown[] = [...files.read, ...files.modified];
  return all.length <= MAX_FILE_COUNT && all.every((path) => typeof path === "string" && !!path.trim()
    && path.length <= MAX_FILE_PATH_CHARS && !/[\r\n\x00-\x1f\x7f]/.test(path))
    && all.reduce<number>((sum, path) => sum + (path as string).length, 0) <= MAX_FILE_CHARS;
}

/** Derived checkpoint data cannot be safely reconciled with a later content edit. */
export function hasContextEditsAfter(entries: SessionEntry[], entryId: string): boolean {
  const index = entries.findIndex((entry) => entry.id === entryId);
  return index < 0 || entries.slice(index + 1).some((entry) => entry.type === "context_edit");
}

/** Recorded calls are not proof that a tool succeeded or that the current file still has that state. */
export function recordedFiles(entries: SessionEntry[], previous?: RecordedFiles, linkedParent?: string): RecordedFiles {
  const read = new Set<string>(), modified = new Set<string>();
  let truncated = false;
  const add = (target: Set<string>, path: unknown) => {
    if (typeof path !== "string" || !path.trim()) return;
    if (path.length > MAX_FILE_PATH_CHARS || /[\r\n\x00-\x1f\x7f]/.test(path)) { truncated = true; return; }
    target.add(path);
  };
  if (validRecordedFiles(previous)) {
    previous.read.forEach((path) => add(read, path));
    previous.modified.forEach((path) => add(modified, path));
    truncated ||= previous.truncated;
  }
  // Transfer metadata is extension state, not summary text. Compaction may remove its
  // projected message before the first local checkpoint, so inspect the active raw
  // branch while still refusing edited/omitted or otherwise invalidated transfers.
  for (const sourceEntry of entries) {
    if (linkedParent && sourceEntry.type === "custom_message" && sourceEntry.customType === "pi-auto-handoff-context"
      && !entries.some((entry) => entry.type === "context_edit" && entry.targetId === sourceEntry.id)
      && !hasContextEditsAfter(entries, sourceEntry.id)) {
      const details = sourceEntry.details as Record<string, unknown> | undefined;
      if (details && [details.sourceSession, details.sourceEntryId, details.handoffId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
        && validRecordedFiles(details.files)) {
        details.files.read.forEach((path) => add(read, path));
        details.files.modified.forEach((path) => add(modified, path));
        truncated ||= details.files.truncated;
      }
    }
  }
  for (const { sourceEntry, messages } of buildSessionProjection(entries).entries) {
    if ((sourceEntry.type === "compaction" || sourceEntry.type === "branch_summary") && messages.length) {
      // Only Pi's native summaries have a recognized file-list contract.
      const details = sourceEntry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
      if (!sourceEntry.fromHook && details && typeof details === "object") {
        if (Array.isArray(details.readFiles)) details.readFiles.forEach((path) => add(read, path));
        if (Array.isArray(details.modifiedFiles)) details.modifiedFiles.forEach((path) => add(modified, path));
      }
    }
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "toolCall" || block.namespace !== undefined) continue;
        if (block.name === "read") add(read, block.arguments?.path);
        else if (block.name === "write" || block.name === "edit") add(modified, block.arguments?.path);
      }
    }
  }
  const result: RecordedFiles = { read: [], modified: [], truncated };
  let chars = 0, count = 0;
  // Modifications take priority over read-only records when a long task exhausts the budget.
  for (const [target, paths] of [[result.modified, [...modified].sort()], [result.read, [...read].filter((path) => !modified.has(path)).sort()]] as const) {
    for (const path of paths) {
      if (count >= MAX_FILE_COUNT || chars + path.length > MAX_FILE_CHARS) { result.truncated = true; continue; }
      target.push(path); chars += path.length; count++;
    }
  }
  return result;
}

export function formatRecordedFiles(files: RecordedFiles): string {
  if (!files.read.length && !files.modified.length && !files.truncated) return "";
  return "\n\n## Recorded file operations\nRecorded calls and carried native file lists, not verified success or current file state.\n"
    + (files.read.length ? `Read: ${files.read.map((path) => JSON.stringify(path)).join(", ")}\n` : "")
    + (files.modified.length ? `Modified: ${files.modified.map((path) => JSON.stringify(path)).join(", ")}\n` : "")
    + (files.truncated ? "[File records truncated.]\n" : "");
}

export function evidence(entries: SessionEntry[], budget: number): { text: string; truncated: boolean; hasWork: boolean } {
  let truncated = false, hasWork = false;
  const blocks = buildSessionProjection(entries).entries.flatMap(({ sourceEntry, messages }) => messages.flatMap((message) => {
    if (message.role === "system") return [];
    // Label before conversion: Pi converts extension/shell/generated messages to user-role text.
    const kind = message.role === "user" ? "user" : message.role === "assistant" ? "assistant"
      : message.role === "toolResult" ? "tool" : message.role === "custom" ? "coordination"
      : message.role === "bashExecution" ? "shell" : "summary";
    const label = kind === "user" ? "user message (origin not authenticated)"
      : message.role === "custom" ? `extension/coordination ${excerpt(message.customType, 80)} (not direct user intent)`
      : message.role === "toolResult" ? `tool result ${excerpt(message.toolName, 80)} (isError=${message.isError})`
      : kind === "shell" ? "shell evidence (not user requirements)"
      : kind === "summary" ? "generated summary (may be incomplete)" : "assistant";
    return convertToLlm([message]).flatMap((converted) => {
      if (converted.role === "system") return [];
      if (converted.role === "user" || converted.role === "assistant") hasWork = true;
      const parts: string[] = [];
      if (typeof converted.content === "string") parts.push(converted.content);
      else for (const block of converted.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "toolCall") parts.push(`Tool ${block.namespace ? `${block.namespace}/` : ""}${block.name}: ${JSON.stringify(block.arguments)}`);
        else if (block.type !== "thinking") { parts.push("[non-text content omitted]"); truncated = true; }
      }
      const text = parts.join("\n");
      if (!text.trim()) return [];
      const limit = Math.min(budget, kind === "user" || kind === "summary" ? 8_000 : kind === "tool" ? 2_000 : 4_000);
      const header = `[${label} | entry ${excerpt(sourceEntry.id, 120)}]\n`;
      const body = excerpt(text, Math.max(0, limit - header.length));
      if (body.length < text.length) truncated = true;
      return [{ kind, text: header + body }];
    });
  }));
  const order = [blocks.find((block) => block.kind === "user"),
    ...blocks.filter((block) => block.kind === "user").toReversed(),
    ...blocks.filter((block) => block.kind === "summary").toReversed(), ...blocks.toReversed()];
  const selected = new Set<typeof blocks[number]>();
  let remaining = budget;
  for (const block of order) {
    if (!block || selected.has(block)) continue;
    const cost = block.text.length + (selected.size ? 2 : 0);
    if (cost > remaining) { truncated = true; continue; }
    selected.add(block); remaining -= cost;
  }
  return { text: blocks.filter((block) => selected.has(block)).map((block) => block.text).join("\n\n"), truncated, hasWork };
}
