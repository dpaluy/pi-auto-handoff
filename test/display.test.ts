import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { checkpointLabel, registerHandoffDisplay, usageLabel } from "../src/display.ts";

test("checkpoint labels tolerate missing or malformed legacy usage", () => {
  assert.equal(usageLabel(undefined), "usage unavailable");
  assert.equal(usageLabel({ input: NaN, output: -1, cost: null }), "usage unavailable");
  assert.equal(usageLabel({ input: 100, output: 20, cost: { total: 0.001 } }), "100 input tokens · 20 output tokens · $0.0010");
  assert.match(checkpointLabel({ model: "fixture\x1b[31m", truncated: true }), /truncated evidence/);
  assert.doesNotMatch(checkpointLabel({ model: "fixture\x1b[31m" }), /\x1b/);
});

test("persisted checkpoint card renders expanded details and narrow widths", () => {
  initTheme("dark");
  let render: any;
  registerHandoffDisplay({ registerEntryRenderer: (_type: string, fn: any) => { render = fn; } } as any);
  const entry = { data: { version: 1, text: "## Goal\nFix the feature.\n\nRecorded file operations\nread: src/index.ts", createdAt: "2026-10-23", trigger: "manual", model: "fixture/chat", truncated: true } };
  const theme = { fg: (_color: string, text: string) => text };
  const compact = render(entry, { expanded: false }, theme);
  assert.match(compact.render(80).join("\n"), /Handoff saved/);
  assert.doesNotMatch(compact.render(80).join("\n"), /Fix the feature|\/handoff continue/);
  assert.match(compact.render(80).join("\n"), /handoff status shows freshness/);
  const expanded = render(JSON.parse(JSON.stringify(entry)), { expanded: true }, theme);
  assert.ok(expanded instanceof Container);
  assert.ok(expanded.children.some((child: unknown) => child instanceof Markdown));
  assert.match(expanded.render(80).join("\n"), /Fix the feature/);
  assert.doesNotMatch(expanded.render(80).join("\n"), /## Goal/);
  for (const width of [1, 8, 30, 80]) {
    assert.ok(expanded.render(width).every((line: string) => visibleWidth(line) <= width), `width ${width}`);
  }
  assert.equal(render({ data: {} }, { expanded: false }, theme), undefined);
});
