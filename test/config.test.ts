import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_NAME, parseSetupArgs, resetSettings, resolveSettings, saveSettings } from "../src/config.ts";

const temp = async (t: any) => { const dir = await mkdtemp(join(tmpdir(), "handoff-config-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const none = () => undefined;

test("defaults apply without a file; saved values beat defaults; flags beat saved values", async (t) => {
  const dir = await temp(t);
  assert.deepEqual(resolveSettings(none, dir).values, { idleMinutes: 50, contextPercent: 70, contextBasis: "window", diagnostics: false });
  saveSettings({ idleMinutes: 30, contextBasis: "compaction" }, dir);
  saveSettings({ contextPercent: 80 }, dir);
  const saved = resolveSettings(none, dir);
  assert.deepEqual(saved.values, { idleMinutes: 30, contextPercent: 80, contextBasis: "compaction", diagnostics: false });
  assert.deepEqual(saved.sources, { idleMinutes: "saved", contextPercent: "saved", contextBasis: "saved", diagnostics: "default" });
  const flagged = resolveSettings((name) => name === "handoff-idle-minutes" ? "5" : undefined, dir);
  assert.equal(flagged.values.idleMinutes, 5); assert.equal(flagged.sources.idleMinutes, "flag");
  assert.equal(((await stat(join(dir, CONFIG_NAME))).mode & 0o777), 0o600);
  resetSettings(dir);
  assert.equal(resolveSettings(none, dir).sources.idleMinutes, "default");
});

test("invalid saved data falls back with a warning; invalid flags and arguments throw", async (t) => {
  const dir = await temp(t);
  await writeFile(join(dir, CONFIG_NAME), "{not json");
  assert.match(resolveSettings(none, dir).warning ?? "", /not valid JSON/);
  await writeFile(join(dir, CONFIG_NAME), JSON.stringify({ idleMinutes: -1, contextPercent: 90, contextBasis: "other" }));
  const partial = resolveSettings(none, dir);
  assert.equal(partial.values.idleMinutes, 50); assert.equal(partial.values.contextPercent, 90); assert.equal(partial.values.contextBasis, "window");
  assert.match(partial.warning ?? "", /idleMinutes, contextBasis/);
  assert.throws(() => resolveSettings((name) => name === "handoff-context-percent" ? "101" : undefined, dir), /--handoff-context-percent/);
  assert.deepEqual(parseSetupArgs("idle=0 percent=85 basis=compaction"), { idleMinutes: 0, contextPercent: 85, contextBasis: "compaction" });
  for (const bad of ["idle", "idle=x", "percent=200", "basis=foo", "color=red", "idle=1=2"]) assert.throws(() => parseSetupArgs(bad));
  // A failed save leaves the previous file intact.
  saveSettings({ idleMinutes: 10 }, dir);
  assert.throws(() => saveSettings({ idleMinutes: 9999 }, dir));
  assert.equal(JSON.parse(await readFile(join(dir, CONFIG_NAME), "utf8")).idleMinutes, 10);
});

test("diagnostics setting parses on/off and defaults off", async (t) => {
  const dir = await temp(t);
  assert.equal(resolveSettings(none, dir).values.diagnostics, false);
  assert.deepEqual(parseSetupArgs("diagnostics=on"), { diagnostics: true });
  assert.throws(() => parseSetupArgs("diagnostics=yes"), /on or off/);
  assert.equal(resolveSettings((name) => name === "handoff-diagnostics" ? "on" : undefined, dir).values.diagnostics, true);
});
