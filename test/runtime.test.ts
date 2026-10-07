import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type CreateAgentSessionRuntimeFactory, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { latestHandoff } from "../src/handoff.ts";

test("real Pi runtime saves, replaces, and continues using the local extension artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-runtime-"));
  const errors: string[] = [];
  const requests: string[] = [];
  const provider = (pi: ExtensionAPI) => pi.registerProvider("handoff-fixture", {
    baseUrl: "http://fixture.invalid", apiKey: "local-fixture", api: "openai-completions",
    models: [{ id: "chat", name: "Local fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
    streamSimple: (model, context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      requests.push(prompt);
      const isSummary = prompt.includes("Write a work handoff");
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "stop",
        content: [{ type: "text", text: isSummary ? "## Goal\nFix the feature.\n\n## Next action\nRead current source before editing." : "Task response from local fixture." }],
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
    const services = await createAgentSessionServices({ cwd, agentDir: dir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }),
      extensionFlagValues: new Map([["handoff-idle-minutes", "0"], ["handoff-context-percent", "0"]]),
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [resolve("src/index.ts")], extensionFactories: [provider] },
    });
    const model = modelRuntime.getModel("handoff-fixture", "chat");
    assert.ok(model);
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model,
      thinkingLevel: "off", tools: [] });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(create, { cwd: dir, agentDir: dir, sessionManager: SessionManager.create(dir, dir) });
  const bind = async (session: AgentSession) => session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error),
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(), newSession: (options) => runtime.newSession(options),
      fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }), reload: async () => {},
    },
  });
  runtime.setRebindSession(bind);
  try {
    await bind(runtime.session);
    await runtime.session.prompt("Fix the feature. Do not deploy.");
    const sourceFile = runtime.session.sessionFile!;
    const sourceId = runtime.session.sessionId;
    await runtime.session.prompt("/handoff");
    const note = latestHandoff(runtime.session.sessionManager.getBranch());
    assert.ok(note);
    assert.equal(runtime.session.sessionId, sourceId);
    assert.doesNotMatch(JSON.stringify(runtime.session.messages), /Read current source before editing/);
    await runtime.session.prompt("/handoff continue");
    assert.notEqual(runtime.session.sessionId, sourceId);
    assert.equal(runtime.session.sessionManager.getHeader()?.parentSession, sourceFile);
    assert.match(JSON.stringify(runtime.session.messages), /Read current source before editing/);
    assert.equal(runtime.session.getLastAssistantText(), "Task response from local fixture.");
    assert.equal(requests.length, 3, "source turn, summarization, and continuation only");
    assert.equal(latestHandoff(SessionManager.open(sourceFile).getBranch())?.id, note.id);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
