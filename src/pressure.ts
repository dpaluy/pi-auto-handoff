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
    const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    if (settings.drainErrors().length) throw new Error("settings could not be loaded");
    const policy = settings.getCompactionSettings(ctx.model);
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
