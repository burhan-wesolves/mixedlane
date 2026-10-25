import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_ROOT } from "../../core/config";

/** Read the same source shipped in plugin bundles, in development and compiled deployments. */
export function defaultAgentSkill() {
  const rel = "integrations/agent-plugins/shared/skills/mixedlane-planning/SKILL.md";
  const file = [resolve(SERVER_ROOT, "../..", rel), resolve(SERVER_ROOT, "../../..", rel)].find(existsSync);
  if (!file) throw new Error("Mixedlane planning skill source is missing");
  return readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}
