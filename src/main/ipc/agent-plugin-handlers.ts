import { parseSetAgentPluginInput } from "@openbot/contracts/ipc";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { parseAgentId } from "./agent-inputs";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

/** Local settings only. Released Team API payloads do not carry plugin access. */
export function agentPluginIpcHandlers({
  service,
}: {
  service: Pick<AgentService, "listAgentPlugins" | "setAgentPlugin">;
}): Pick<IpcGroupHandlers, "agentPlugins"> {
  return {
    agentPlugins: {
      listAgentPlugins: payloadHandler(parseAgentId, (agentId) => service.listAgentPlugins(agentId)),
      setAgentPlugin: payloadHandler(parseSetAgentPluginInput, (input) =>
        runCauseEffect(service.setAgentPlugin(input)),
      ),
    },
  };
}
