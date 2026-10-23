import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDiagnostics, diagnosticRecord, DIAGNOSTIC_NAME } from "../src/diagnostics.ts";

test("diagnostics serialize only finite allowlisted metadata", () => {
  const record = diagnosticRecord({ sessionId: "safe-id", event: "saved", reason: "generation", trigger: "idle", cost: NaN,
    durationMs: -1, evidenceChars: 123, truncated: true, evidence: "SECRET", text: "SECRET", error: new Error("SECRET") } as any);
  assert.doesNotMatch(JSON.stringify(record), /SECRET|evidence\"|durationMs|cost/);
  assert.equal(record.evidenceChars, 123);
  assert.equal(diagnosticRecord({ sessionId: "/secret/path", event: "failed" }).sessionId, "unknown");
});

test("diagnostics rotate within cap with private permissions and drop on contention", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "diagnostics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = createDiagnostics(dir, 400);
  const path = join(dir, DIAGNOSTIC_NAME);
  for (let i = 0; i < 20; i++) assert.equal(log.append({ sessionId: "session", event: "saved", evidenceChars: i }), true);
  assert.ok(statSync(path).size <= 400);
  assert.ok(statSync(`${path}.1`).size <= 400);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), [DIAGNOSTIC_NAME, `${DIAGNOSTIC_NAME}.1`]);
  writeFileSync(`${path}.lock`, "lock");
  const before = readFileSync(path, "utf8");
  assert.equal(log.append({ sessionId: "session", event: "failed" }), false);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.match(log.status(), /unavailable or busy/);
});

test("diagnostics never throw on invalid targets and refuse symlink logs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "diagnostics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "private");
  writeFileSync(target, "keep");
  assert.equal(createDiagnostics(target).append({ sessionId: "session", event: "start" }), false);
  symlinkSync(target, join(dir, DIAGNOSTIC_NAME));
  assert.equal(createDiagnostics(dir).append({ sessionId: "session", event: "start" }), false);
  assert.equal(readFileSync(target, "utf8"), "keep");
});
