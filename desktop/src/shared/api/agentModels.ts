import type { AgentModelsResponse } from "@/shared/api/types";
import { invokeTauri } from "@/shared/api/tauri";

export type DiscoverAgentModelsInput = {
  /**
   * The model the agent is saved with. A Claude probe starts on it, as the
   * agent does, so the catalog lists it even when Claude Code offers that id
   * only to a session already on it (e.g. `opus[1m]`).
   */
  startModel?: string;
  acpCommand?: string;
  agentCommand: string;
  agentArgs?: string[];
  provider?: string;
  envVars?: Record<string, string>;
  /** Definition-level env from the harness definition (custom/preset). Merged below user envVars. */
  definitionEnv?: Record<string, string>;
  /**
   * Select this model during the probe so `effortLevels` describes it rather
   * than the agent's default. Costs one extra round-trip on the session the
   * probe already holds, so callers wanting only the catalog leave it unset.
   */
  model?: string;
};

export async function discoverAgentModels(input: DiscoverAgentModelsInput) {
  return invokeTauri<AgentModelsResponse>("discover_agent_models", { input });
}
