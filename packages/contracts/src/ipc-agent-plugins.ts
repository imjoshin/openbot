import { sourceText } from "@openbot/i18n/source";
import { isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord } from "./runtime-values";

/** Local MCP access. No connection addresses or credentials cross this boundary. */
export interface AgentPlugin {
  id: string;
  name: string;
  enabled: boolean;
  available: boolean;
}
export interface SetAgentPluginInput {
  agentId: string;
  pluginId: string;
  enabled: boolean;
}
export function isDisabledMcpServerIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 4096 && value.every(isIdentifier);
}
export function parseSetAgentPluginInput(value: unknown): SetAgentPluginInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.pluginId) ||
    typeof value.enabled !== "boolean"
  )
    throw new Error(sourceText("error.agent.pluginAccessInvalid"));
  return { agentId: value.agentId, pluginId: value.pluginId, enabled: value.enabled };
}
export function decodeAgentPluginsFromMain(value: unknown): AgentPlugin[] {
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    !value.every(
      (row) =>
        isDynamicRecord(row) &&
        isIdentifier(row.id) &&
        typeof row.name === "string" &&
        row.name.length <= 4096 &&
        typeof row.enabled === "boolean" &&
        typeof row.available === "boolean",
    )
  )
    throw new Error(sourceText("error.agent.pluginAccessInvalid"));
  return value;
}
