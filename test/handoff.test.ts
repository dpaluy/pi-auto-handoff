import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import extension from "../src/index.ts";
import { ENTRY_TYPE, latestHandoff, MAX_INPUT_CHARS, snapshot } from "../src/handoff.ts";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((done) => setImmediate(done)); };
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = (text = "## Goal\nFinish the task.\n\n## Next action\nRead the current tests before editing.") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage,
});
const forbidden = () => { throw new Error("Unrelated Pi control was called"); };

async function fixture(t: TestContext, ephemeral = false) {
  const dir = await mkdtemp(join(tmpdir(), "auto-handoff-"));
  const manager = ephemeral ? SessionManager.inMemory(dir) : SessionManager.create(dir, dir);
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const flags = new Map<string, string>();
  const calls: any[] = [];
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  let idle = true, queued = false, percent: number | null = 20, replaced = false;
  let provider: () => Promise<any> = async () => response();
  let appendFails = false, switchCanceled = false, deliveryFails = false;
  let replacement: SessionManager | undefined;
  let sourceAccessAfterSwitch = 0;
  const check = () => { if (replaced) { sourceAccessAfterSwitch++; throw new Error("Stale source context"); } };
  const model = { provider: "fixture", id: "chat", api: "openai-completions", contextWindow: 100_000, maxTokens: 4096 };
  const ctx: any = {
    mode: "tui", hasUI: true, cwd: dir, model,
    sessionManager: new Proxy(manager, { get(target, key) {
      check(); const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }),
    ui: {
      notify: (text: string) => { check(); notices.push(text); },
      setStatus: (_key: string, text: string | undefined) => { check(); statuses.push(text); },
    },
    isIdle: () => { check(); return idle; }, hasPendingMessages: () => { check(); return queued; },
    getContextUsage: () => { check(); return { tokens: percent === null ? null : percent * 1000, contextWindow: 100_000, percent }; },
    compact: forbidden, abort: forbidden,
    waitForIdle: async () => { check(); },
    modelRegistry: { streamSimple: (selected: any, context: any, options: any) => {
      check(); calls.push({ model: selected, context, options });
      return { result: provider };
    } },
    newSession: async (options: any) => {
      check();
      assert.equal(options.parentSession, manager.getSessionFile());
      if (switchCanceled) return { cancelled: true };
      replacement = SessionManager.create(dir, dir, { parentSession: options.parentSession });
      await options.setup(replacement);
      await handlers.get("session_shutdown")?.({ reason: "new" }, ctx);
      replaced = true;
      const fresh: any = {
        ui: { notify: (text: string) => notices.push(text) },
        sendUserMessage: async (content: string) => {
          if (deliveryFails) throw new Error("delivery failure");
          replacement!.appendMessage({ role: "user", content, timestamp: Date.now() });
        },
      };
      await options.withSession(fresh);
      return { cancelled: false };
    },
  };
  const pi: any = {
    registerFlag: (name: string, options: any) => flags.set(name, options.default),
    getFlag: (name: string) => { check(); return flags.get(name); },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    appendEntry: (type: string, data: any) => {
      check(); manager.appendCustomEntry(type, data);
      if (appendFails) throw new Error("disk full");
    },
    setModel: forbidden, setThinkingLevel: forbidden, setActiveTools: forbidden,
    sendMessage: forbidden, sendUserMessage: forbidden, exec: forbidden,
  };
  extension(pi);
  const addUser = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  const firstUser = addUser("Implement the feature. Preserve user edits. Do not deploy.");
  manager.appendMessage({ ...response("Tests failed: expected 2, got 1. Next: inspect the condition."), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() } as any);
  await handlers.get("session_start")?.({}, ctx);
  t.after(async () => {
    if (!replaced) await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir, manager, ctx, calls, notices, statuses, flags, handlers, firstUser, addUser,
    invoke: (args = "") => commands.get("handoff").handler(args, ctx),
    emit: (name: string) => handlers.get(name)?.({}, ctx),
    note: () => latestHandoff(manager.getBranch()),
    setProvider: (value: () => Promise<any>) => { provider = value; },
    setIdle: (value: boolean) => { idle = value; }, setQueued: (value: boolean) => { queued = value; },
    setPercent: (value: number | null) => { percent = value; },
    failAppend: () => { appendFails = true; }, cancelSwitch: () => { switchCanceled = true; },
    failDelivery: () => { deliveryFails = true; },
    get replacement() { return replacement; }, get sourceAccessAfterSwitch() { return sourceAccessAfterSwitch; },
  };
}

test("native Pi loader loads the package entry", async () => {
  const loaded = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has("handoff"));
});

test("manual checkpoint persists outside source context; reload and repeat reuse it", async (t) => {
  const f = await fixture(t);
  const original = buildSessionContext(f.manager.getBranch()).messages;
  await f.invoke();
  const note = f.note()!;
  assert.equal(note.trigger, "manual");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].context.tools, undefined);
  assert.equal(f.calls[0].options.maxRetries, 0);
  assert.equal(f.calls[0].options.cacheRetention, "none");
  assert.match(f.calls[0].context.messages[0].content, /Tests failed/);
  assert.deepEqual(buildSessionContext(f.manager.getBranch()).messages, original);
  const reopened = SessionManager.open(f.manager.getSessionFile()!);
  assert.equal(latestHandoff(reopened.getBranch())?.id, note.id);
  assert.match(await readFile(f.manager.getSessionFile()!, "utf8"), new RegExp(note.id));
  await f.emit("session_start"); await f.invoke();
  assert.equal(f.calls.length, 1);
});

test("continuation refreshes a stale note, preserves source, and only uses fresh context", async (t) => {
  const f = await fixture(t);
  await f.invoke(); const old = f.note()!;
  f.addUser("New requirement: preserve retry semantics.");
  await f.invoke("continue");
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.note()?.id, old.id);
  assert.match(f.calls[1].context.messages[0].content, /preserve retry semantics/);
  assert.equal(f.replacement!.getHeader()?.parentSession, f.manager.getSessionFile());
  const freshMessages = buildSessionContext(f.replacement!.getBranch()).messages;
  assert.equal(freshMessages.length, 2);
  assert.match(JSON.stringify(freshMessages), /saved handoff above/);
  assert.match(JSON.stringify(freshMessages), /Read the current tests/);
  assert.doesNotMatch(JSON.stringify(freshMessages), /Tests failed: expected 2/);
  assert.equal(f.sourceAccessAfterSwitch, 0);
  assert.ok(SessionManager.open(f.manager.getSessionFile()!).getBranch().some((e) => e.type === "custom" && e.customType === ENTRY_TYPE));
});

test("canceled session switch retains a saved checkpoint", async (t) => {
  const f = await fixture(t); f.cancelSwitch();
  await f.invoke("continue");
  assert.ok(f.note()); assert.equal(f.replacement, undefined);
  assert.match(f.notices.join("\n"), /change canceled/);
});

test("delivery failure reports through fresh UI and preserves source note", async (t) => {
  const f = await fixture(t); f.failDelivery();
  await f.invoke("continue");
  assert.ok(f.note()); assert.ok(f.replacement);
  assert.equal(f.sourceAccessAfterSwitch, 0);
  assert.match(f.notices.join("\n"), /Continuation failed/);
});

test("queued input and ephemeral sessions do not generate or switch", async (t) => {
  const f = await fixture(t); f.setQueued(true);
  await f.invoke("continue");
  assert.equal(f.calls.length, 0); assert.equal(f.replacement, undefined);
  const ephemeral = await fixture(t, true);
  await ephemeral.invoke("continue");
  assert.equal(ephemeral.calls.length, 0); assert.equal(ephemeral.replacement, undefined);
});

test("input aborts generation even when the provider ignores its signal", async (t) => {
  const f = await fixture(t);
  let finish!: (value: any) => void;
  f.setProvider(() => new Promise((done) => { finish = done; }));
  const command = f.invoke(); await flush();
  await f.emit("input");
  await command;
  assert.equal(f.calls[0].options.signal.aborted, true);
  finish(response()); await flush();
  assert.equal(f.note(), undefined);
  assert.equal(f.replacement, undefined);
});

test("branch movement without a hook discards a stale async result", async (t) => {
  const f = await fixture(t);
  let finish!: (value: any) => void;
  f.setProvider(() => new Promise((done) => { finish = done; }));
  const command = f.invoke("continue"); await flush();
  f.manager.branch(f.firstUser);
  finish(response()); await command;
  assert.equal(f.note(), undefined); assert.equal(f.replacement, undefined);
});

test("abandoned branch checkpoints are not reused", async (t) => {
  const f = await fixture(t); await f.invoke(); const old = f.note()!;
  f.manager.branch(f.firstUser); await f.emit("session_tree");
  f.addUser("Use a different implementation."); await f.invoke();
  assert.equal(f.calls.length, 2); assert.notEqual(f.note()?.id, old.id);
  assert.doesNotMatch(f.calls[1].context.messages[0].content, /previousHandoff/);
});

test("pressure generates after settlement only, once per high-pressure episode", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = await fixture(t); f.setPercent(75);
  await f.emit("agent_settled"); assert.equal(f.calls.length, 0);
  t.mock.timers.tick(0); await flush();
  assert.equal(f.note()?.trigger, "pressure"); assert.equal(f.calls.length, 1);
  await f.emit("agent_start"); f.addUser("Additional work.");
  await f.emit("agent_settled"); t.mock.timers.tick(0); await flush();
  assert.equal(f.calls.length, 1);
  await f.emit("input"); f.setPercent(25); await f.emit("agent_settled"); t.mock.timers.tick(0);
  await f.emit("input"); f.addUser("Context grew again."); f.setPercent(80);
  await f.emit("agent_settled"); t.mock.timers.tick(0); await flush();
  assert.equal(f.calls.length, 2);
});

test("idle fires once, cancels on input, and rearms after returned work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = await fixture(t); f.flags.set("handoff-idle-minutes", "1");
  await f.emit("agent_settled"); t.mock.timers.tick(0);
  t.mock.timers.tick(30_000); await f.emit("input");
  t.mock.timers.tick(60_000); await flush(); assert.equal(f.calls.length, 0);
  f.addUser("Returned work."); await f.emit("agent_settled"); t.mock.timers.tick(0);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.note()?.trigger, "idle"); assert.equal(f.calls.length, 1);
  await f.emit("agent_settled"); t.mock.timers.tick(120_000); await flush();
  assert.equal(f.calls.length, 1);
});

test("late wake skips an idle call instead of spending after the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: 0 });
  const f = await fixture(t); f.flags.set("handoff-idle-minutes", "1");
  await f.emit("agent_settled"); t.mock.timers.tick(0);
  const now = Date.now(); t.mock.method(Date, "now", () => now + 120_000);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.calls.length, 0);
  assert.match(f.statuses.join("\n"), /late wake/);
});

test("unknown context does not cause pressure calls; active, headless, and shutdown sessions skip timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = await fixture(t); f.setPercent(null); f.flags.set("handoff-idle-minutes", "0");
  await f.emit("agent_settled"); t.mock.timers.tick(0); await flush(); assert.equal(f.calls.length, 0);
  f.setPercent(90); f.setIdle(false); await f.emit("agent_settled"); t.mock.timers.tick(0); await flush(); assert.equal(f.calls.length, 0);
  f.setIdle(true); f.ctx.mode = "print"; await f.emit("agent_settled"); t.mock.timers.tick(0); await flush(); assert.equal(f.calls.length, 0);
  f.ctx.mode = "tui"; await f.emit("agent_settled"); await f.emit("session_shutdown");
  t.mock.timers.tick(60_000); await flush(); assert.equal(f.calls.length, 0);
});

test("failed pressure attempt does not loop or expose provider error text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = await fixture(t); f.setPercent(90); f.flags.set("handoff-idle-minutes", "0");
  f.setProvider(async () => { throw new Error("secret-api-key"); });
  await f.emit("agent_settled"); t.mock.timers.tick(0); await flush();
  await f.emit("agent_settled"); t.mock.timers.tick(0); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.note(), undefined);
  assert.doesNotMatch(f.notices.join("\n"), /secret-api-key/);
});

test("timeout returns control even when the provider never completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = await fixture(t); f.setProvider(() => new Promise(() => {}));
  const command = f.invoke("continue"); await flush();
  t.mock.timers.tick(40_000); await command;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.note(), undefined); assert.equal(f.replacement, undefined);
  assert.match(f.notices.join("\n"), /timed out/);
});

test("save failure does not switch or hide the previous checkpoint", async (t) => {
  const f = await fixture(t); await f.invoke(); const old = f.note()!;
  f.addUser("Changed task."); f.failAppend(); await f.invoke("continue");
  assert.equal(f.replacement, undefined);
  assert.match(f.notices.join("\n"), /could not be saved/);
  await f.invoke("status");
  assert.match(f.notices.at(-1)!, new RegExp(old.createdAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("empty, incomplete, and tool-call responses never become checkpoints", async (t) => {
  const f = await fixture(t);
  for (const value of [response(""), { ...response(), stopReason: "length" }, { ...response(), content: [{ type: "toolCall", name: "write", arguments: {} }] }]) {
    f.setProvider(async () => value); await f.invoke("continue");
    assert.equal(f.note(), undefined); assert.equal(f.replacement, undefined);
  }
});

test("snapshot is bounded, excludes thinking, honors context edits, and includes compaction summaries", async (t) => {
  const f = await fixture(t);
  const edited = f.addUser("Old obsolete requirement.");
  f.manager.appendContextEdit(edited, { role: "user", content: "Corrected requirement.", timestamp: Date.now() } as any);
  const before = snapshot(f.ctx);
  assert.match(before.evidence, /Corrected requirement/);
  assert.doesNotMatch(before.evidence, /Old obsolete requirement/);
  f.manager.appendCompaction("Summary: retain settled constraints.", null, 1000);
  f.addUser("Newest request.");
  for (let i = 0; i < 100; i++) f.manager.appendMessage({ ...response("x".repeat(6000)), content: [{ type: "thinking", thinking: "private-thought", thinkingSignature: "" }, { type: "text", text: "x".repeat(6000) }], api: "openai-completions", provider: "fixture", model: "chat", timestamp: Date.now() } as any);
  const captured = snapshot(f.ctx);
  assert.ok(captured.evidence.length <= MAX_INPUT_CHARS);
  assert.equal(captured.truncated, true);
  assert.match(captured.evidence, /retain settled constraints/);
  assert.match(captured.evidence, /Newest request/);
  assert.doesNotMatch(captured.evidence, /private-thought/);
});

test("native compaction hooks remain passive and cancel a pending checkpoint", async (t) => {
  const f = await fixture(t);
  let finish!: (value: any) => void;
  f.setProvider(() => new Promise((done) => { finish = done; }));
  const command = f.invoke(); await flush();
  assert.equal(await f.emit("session_before_compact"), undefined);
  await command; finish(response()); await flush();
  assert.equal(f.note(), undefined);
});

test("invalid trigger flags fail safely before automatic calls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = await fixture(t); f.flags.set("handoff-context-percent", "NaN");
  await f.emit("agent_settled"); t.mock.timers.tick(0); await flush();
  assert.equal(f.calls.length, 0); assert.match(f.notices.join("\n"), /must be a number/);
});
