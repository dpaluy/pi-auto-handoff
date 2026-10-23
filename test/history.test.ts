import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE } from "../src/handoff.ts";
import { MAX_HISTORY_BYTES, MAX_HISTORY_CHARS, registerHandoffHistory } from "../src/history.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = SessionManager.create(dir, dir);
  const user = (text: string) => parent.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  const first = user("First task: preserve old investigation and tests.");
  let tool: any;
  registerHandoffHistory({ registerTool: (value: unknown) => { tool = value; } } as any);
  const checkpoint = () => {
    const sourceId = parent.getLeafId()!;
    const note = { version: 1, id: `handoff-${sourceId}`, sessionId: parent.getSessionId(), sourceEntryId: sourceId,
      createdAt: new Date().toISOString(), trigger: "manual", model: "fixture/test", text: "## Goal\nContinue safely.", truncated: true };
    parent.appendCustomEntry(ENTRY_TYPE, note);
    const child = SessionManager.create(dir, dir, { parentSession: parent.getSessionFile()! });
    child.appendCustomMessageEntry("pi-auto-handoff-context", note.text, true, {
      sourceSession: note.sessionId, sourceEntryId: sourceId, handoffId: note.id,
    });
    child.appendMessage({ role: "user", content: "Continue.", timestamp: Date.now() });
    return { child, note };
  };
  const run = async (child: SessionManager, params: unknown, signal?: AbortSignal) => {
    const output = await tool.execute("history-call", params, signal, undefined, { sessionManager: child });
    assert.equal(output.details, undefined);
    const text = output.content[0].text as string;
    assert.ok(text.length <= MAX_HISTORY_CHARS);
    return text;
  };
  return { dir, parent, user, first, checkpoint, run, tool };
}

test("linked saved session and resume recover only checkpoint source branch without writes", async (t) => {
  const f = await fixture(t);
  const saved = f.user("needle original branch");
  const { child } = f.checkpoint();
  f.user("needle later parent activity");
  f.parent.branch(f.first);
  const sibling = f.user("needle sibling branch");
  const before = await readFile(f.parent.getSessionFile()!, "utf8");
  const files = await readdir(f.dir);
  const resumed = SessionManager.open(child.getSessionFile()!);
  const result = await f.run(resumed, { op: "search", query: "needle" });
  assert.match(result, /needle original branch/);
  assert.doesNotMatch(result, /later parent activity|sibling branch/);
  assert.match(await f.run(resumed, { op: "read", entryId: saved }), /needle original branch/);
  await assert.rejects(f.run(resumed, { op: "read", entryId: sibling }), /unavailable/);
  assert.equal(await readFile(f.parent.getSessionFile()!, "utf8"), before);
  assert.deepEqual(await readdir(f.dir), files);
});

test("compacted history remains recoverable while replacement and omission edits stay private", async (t) => {
  const f = await fixture(t);
  const secret = f.user("SECRET original value");
  const omitted = f.user("OMITTED original value");
  f.parent.appendContextEdit(secret, { content: "safe replacement evidence" });
  f.parent.appendContextEdit(omitted, null);
  const latest = f.user("latest retained input");
  f.parent.appendCompaction("generated checkpoint", latest, 10_000);
  const { child } = f.checkpoint();
  assert.match(await f.run(child, { op: "read", entryId: f.first }), /old investigation/);
  assert.match(await f.run(child, { op: "read", entryId: secret }), /safe replacement/);
  assert.doesNotMatch(await f.run(child, { op: "search", query: "SECRET" }), /SECRET original/);
  await assert.rejects(f.run(child, { op: "read", entryId: omitted }), /unavailable/);
});

test("privacy filtering excludes thinking, signatures, system text, images, raw details and state", async (t) => {
  const f = await fixture(t);
  f.parent.appendMessage({ role: "system", content: "SYSTEM-PRIVATE", timestamp: Date.now() });
  const assistant = f.parent.appendMessage({ role: "assistant", content: [
    { type: "thinking", thinking: "THINKING-PRIVATE", thinkingSignature: "SIGNATURE-PRIVATE" },
    { type: "text", text: "public assistant text", textSignature: "TEXT-SIGNATURE-PRIVATE" },
    { type: "toolCall", id: "call", name: "read", arguments: { path: "src/a.ts" }, thoughtSignature: "CALL-SIGNATURE-PRIVATE" },
  ], timestamp: Date.now() } as any);
  const result = f.parent.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", isError: true,
    content: [{ type: "text", text: "public tool error" }, { type: "image", data: "IMAGE-PRIVATE", mimeType: "image/png" }], details: { token: "DETAILS-PRIVATE" }, timestamp: Date.now() });
  f.parent.appendCustomEntry("private-state", { value: "STATE-PRIVATE" });
  const custom = f.parent.appendCustomMessageEntry("intercom", "coordination message", true, { token: "CUSTOM-PRIVATE" });
  const { child } = f.checkpoint();
  const text = await f.run(child, { op: "read", entryId: assistant });
  assert.match(text, /public assistant text|src\/a.ts/);
  assert.doesNotMatch(text, /THINKING-PRIVATE|SIGNATURE-PRIVATE/);
  const tool = await f.run(child, { op: "read", entryId: result });
  assert.match(tool, /tool read \(error\)/);
  assert.doesNotMatch(tool, /IMAGE-PRIVATE|DETAILS-PRIVATE/);
  const coordination = await f.run(child, { op: "read", entryId: custom });
  assert.match(coordination, /not direct user intent/);
  assert.doesNotMatch(coordination, /CUSTOM-PRIVATE/);
  for (const query of ["SYSTEM-PRIVATE", "STATE-PRIVATE"]) assert.match(await f.run(child, { op: "search", query }), /No matching entries/);
});

test("linkage rejects missing parent, wrong identity and forged checkpoint content", async (t) => {
  const f = await fixture(t);
  const plain = SessionManager.inMemory(f.dir);
  await assert.rejects(f.run(plain, { op: "search", query: "task" }), /linked handoff/);
  const { child, note } = f.checkpoint();
  const forged = SessionManager.inMemory(f.dir, { parentSession: f.parent.getSessionFile()! });
  await assert.rejects(f.run(forged, { op: "search", query: "task" }), /linked handoff/);
  const marker = (details: any, content = note.text) => forged.appendCustomMessageEntry("pi-auto-handoff-context", content, true, details);
  marker({ sourceSession: "wrong", sourceEntryId: note.sourceEntryId, handoffId: note.id });
  await assert.rejects(f.run(forged, { op: "search", query: "task" }), /identity/);
  marker({ sourceSession: note.sessionId, sourceEntryId: note.sourceEntryId, handoffId: "nonexistent" });
  await assert.rejects(f.run(forged, { op: "search", query: "task" }), /checkpoint is missing/);
  marker({ sourceSession: note.sessionId, sourceEntryId: "wrong-source-entry", handoffId: note.id });
  await assert.rejects(f.run(forged, { op: "search", query: "task" }), /does not match/);
  marker({ sourceSession: note.sessionId, sourceEntryId: note.sourceEntryId, handoffId: note.id }, "forged content");
  await assert.rejects(f.run(forged, { op: "search", query: "task" }), /does not match/);
  await rm(f.parent.getSessionFile()!);
  await assert.rejects(f.run(child, { op: "search", query: "task" }), /ENOENT/);
});

test("saved shell history preserves failure, cancellation, and output truncation outcomes", async (t) => {
  const f = await fixture(t);
  const appendShell = (exitCode: number | undefined, cancelled: boolean, truncated: boolean) => f.parent.appendMessage({
    role: "bashExecution", command: "npm test", output: "partial test output", exitCode, cancelled, truncated, timestamp: Date.now(),
  });
  const failed = appendShell(2, false, false);
  const cancelled = appendShell(undefined, true, false);
  const truncated = appendShell(0, false, true);
  const combined = appendShell(137, true, true);
  const { child } = f.checkpoint();
  const resumed = SessionManager.open(child.getSessionFile()!);
  for (const [id, expected] of [
    [failed, "exitCode=2; cancelled=false; outputTruncated=false"],
    [cancelled, "exitCode=unknown; cancelled=true; outputTruncated=false"],
    [truncated, "exitCode=0; cancelled=false; outputTruncated=true"],
    [combined, "exitCode=137; cancelled=true; outputTruncated=true"],
  ]) {
    const text = await f.run(resumed, { op: "read", entryId: id });
    assert.ok(text.includes(expected), `Missing recorded shell outcome: ${expected}`);
    assert.match(text, /npm test\npartial test output/);
  }
});

test("literal search and read pages preserve bounds and paging instructions", async (t) => {
  const f = await fixture(t);
  const long = f.user("START [literal.*] " + "a".repeat(20_000) + " END-LOG-FAILURE");
  for (let i = 0; i < 9; i++) f.user(`match item ${i}`);
  const { child } = f.checkpoint();
  const first = await f.run(child, { op: "read", entryId: long });
  assert.match(first, /START/);
  assert.match(first, /offset=6500/);
  const last = await f.run(child, { op: "read", entryId: long, offset: 19_500 });
  assert.match(last, /END-LOG-FAILURE/);
  assert.match(await f.run(child, { op: "search", query: "[literal.*]" }), /START/);
  assert.match(await f.run(child, { op: "search", query: "match item" }), /offset=6/);
  const next = await f.run(child, { op: "search", query: "match item", offset: 6 });
  assert.match(next, /match item 8/);
  assert.doesNotMatch(next, /match item 0/);
});

test("reject invalid arguments, arbitrary paths, offsets, oversized input and cancellation", async (t) => {
  const f = await fixture(t);
  const { child } = f.checkpoint();
  for (const params of [
    { op: "read", entryId: f.first, offset: -1 }, { op: "read", entryId: f.first, offset: 1.5 },
    { op: "read", entryId: f.first, offset: 100_000 }, { op: "search", query: "task", offset: 50 },
    { op: "search", query: "" }, { op: "search", query: "a".repeat(257) },
    { op: "search", query: "task", path: "/etc/passwd" },
  ]) await assert.rejects(f.run(child, params), /offset|requires|without a path/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.run(child, { op: "search", query: "task" }, controller.signal), { name: "AbortError" });
  await truncate(f.parent.getSessionFile()!, MAX_HISTORY_BYTES + 1);
  await assert.rejects(f.run(child, { op: "search", query: "task" }), /32 MiB/);
});

test("malformed records and cyclic/duplicate tree data fail closed", async (t) => {
  const f = await fixture(t);
  const { child } = f.checkpoint();
  const path = f.parent.getSessionFile()!;
  const original = await readFile(path, "utf8");
  await writeFile(path, original + "not-json\n");
  await assert.rejects(f.run(child, { op: "search", query: "task" }), /malformed records/);
  const lines = original.trim().split("\n");
  const entry = JSON.parse(lines[1]); entry.parentId = entry.id;
  lines[1] = JSON.stringify(entry);
  await writeFile(path, lines.join("\n") + "\n");
  await assert.rejects(f.run(child, { op: "search", query: "task" }), /tree is invalid/);
});
