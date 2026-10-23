import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pressureBasis, pressureState } from "../src/pressure.ts";

test("window pressure preserves percent semantics and handles unknown/disabled usage", () => {
  const ctx: any = { getContextUsage: () => ({ percent: 70, tokens: 70_000, contextWindow: 100_000 }) };
  assert.equal(pressureState(ctx, 70, "window").high, true);
  assert.equal(pressureState(ctx, 71, "window").high, false);
  assert.equal(pressureState(ctx, 0, "compaction").high, false);
  ctx.getContextUsage = () => ({ percent: null, tokens: null, contextWindow: 100_000 });
  assert.equal(pressureState(ctx, 70, "window").available, false);
  assert.throws(() => pressureBasis("other"), /window or compaction/);
});

test("compaction basis reads model overrides, respects trust, and never writes settings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pressure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const global = join(dir, "settings.json"), project = join(cwd, ".pi", "settings.json");
  writeFileSync(global, JSON.stringify({ compaction: { reserveTokens: 10_000, modelOverrides: { "fixture/chat": { reserveTokens: 40_000 } } } }));
  writeFileSync(project, JSON.stringify({ compaction: { modelOverrides: { "fixture/chat": { reserveTokens: 60_000 } } } }));
  const before = [readFileSync(global, "utf8"), readFileSync(project, "utf8")];
  let trusted = false, tokens: number | null = 42_000;
  const ctx: any = { cwd, model: { provider: "fixture", id: "chat" }, isProjectTrusted: () => trusted,
    getContextUsage: () => ({ percent: 42, tokens, contextWindow: 100_000 }) };
  assert.equal(pressureState(ctx, 70, "compaction", dir).thresholdTokens, 42_000);
  assert.equal(pressureState(ctx, 70, "compaction", dir).high, true);
  trusted = true;
  assert.equal(pressureState(ctx, 70, "compaction", dir).thresholdTokens, 28_000);
  assert.match(pressureState(ctx, 70, "compaction", dir).description, /file-backed.*SDK in-memory/);
  tokens = null;
  assert.equal(pressureState(ctx, 70, "compaction", dir).available, false);
  assert.deepEqual([readFileSync(global, "utf8"), readFileSync(project, "utf8")], before);
  writeFileSync(project, JSON.stringify({ compaction: { modelOverrides: { "fixture/chat": { reserveTokens: 100_000 } } } }));
  assert.equal(pressureState(ctx, 70, "compaction", dir).available, false);
  writeFileSync(project, "{");
  assert.equal(pressureState(ctx, 70, "compaction", dir).available, false);
  trusted = false;
  tokens = 42_000;
  assert.equal(pressureState(ctx, 70, "compaction", dir).available, true, "untrusted malformed project settings ignored");
  writeFileSync(global, JSON.stringify({ compaction: { enabled: false } }));
  assert.match(pressureState(ctx, 70, "compaction", dir).description, /window fallback/);
  writeFileSync(global, JSON.stringify({ compaction: { reserveTokens: -1 } }));
  assert.equal(pressureState(ctx, 70, "compaction", dir).available, false);
});
