import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PressureBasis = "window" | "compaction";
export interface PressureResult {
  high: boolean;
  available: boolean;
  description: string;
  thresholdTokens?: number;
}

export function pressureBasis(raw: unknown): PressureBasis {
  if (raw !== "window" && raw !== "compaction") throw new Error("--handoff-context-basis must be window or compaction.");
  return raw;
}

type CompactionPolicy = ReturnType<SettingsManager["getCompactionSettings"]>;
// One most-recent policy keeps the cache bounded; identity/file changes always reload.
let cachedPolicy: { key: string; policy: CompactionPolicy } | undefined;
function fileStamp(path: string): string {
  try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
function configuredPolicy(ctx: Pick<ExtensionContext, "cwd" | "model" | "isProjectTrusted">, agentDir: string): CompactionPolicy {
  const cwd = resolve(ctx.cwd), agent = resolve(agentDir), trusted = ctx.isProjectTrusted();
  const key = JSON.stringify([cwd, agent, trusted, ctx.model?.provider, ctx.model?.id,
    fileStamp(join(agent, "settings.json")), trusted ? fileStamp(join(cwd, ".pi", "settings.json")) : "untrusted"]);
  if (cachedPolicy?.key === key) return cachedPolicy.policy;
  // Pi's loader never modifies settings content here, but does acquire read lock files.
  const settings = SettingsManager.create(cwd, agent, { projectTrusted: trusted });
  if (settings.drainErrors().length) throw new Error("settings could not be loaded");
  const policy = settings.getCompactionSettings(ctx.model);
  cachedPolicy = { key, policy };
  return policy;
}

/** Disk-backed policy only: Pi 1.0.4 does not expose SDK in-memory settings here. */
export function pressureState(ctx: Pick<ExtensionContext, "cwd" | "model" | "getContextUsage" | "isProjectTrusted">,
  percent: number, basis: PressureBasis, agentDir = getAgentDir()): PressureResult {
  if (percent === 0) return { high: false, available: true, description: "Pressure checkpoints disabled." };
  const usage = ctx.getContextUsage();
  const windowState = (suffix = ""): PressureResult => {
    const known = usage?.percent != null && Number.isFinite(usage.percent);
    return { high: known && usage.percent! >= percent, available: known,
      description: `Pressure: ${percent}% of estimated context window${suffix}${known ? "." : "; usage unavailable."}` };
  };
  if (basis === "window") return windowState();
  try {
    const policy = configuredPolicy(ctx, agentDir);
    if (!policy.enabled) return windowState(" (file-backed compaction disabled; window fallback)");
    if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens) || !Number.isFinite(usage.contextWindow)
      || usage.contextWindow <= policy.reserveTokens) {
      return { high: false, available: false, description: "Pressure unavailable: usage or configured file-backed compaction budget is unknown/invalid (SDK overrides unavailable)." };
    }
    const thresholdTokens = (usage.contextWindow - policy.reserveTokens) * percent / 100;
    return { high: usage.tokens >= thresholdTokens, available: true, thresholdTokens,
      description: `Pressure: ${percent}% of configured file-backed compaction budget (≈${Math.ceil(thresholdTokens)} tokens; SDK in-memory overrides unavailable).` };
  } catch {
    return { high: false, available: false, description: "Pressure unavailable: configured file-backed compaction settings could not be read (SDK overrides unavailable)." };
  }
}
