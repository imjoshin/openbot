import type { AgentAccessPolicyCalls } from "@openbot/ui/features/servers/AgentGroups";

export function agentAccessPolicyPort() {
  return window.openbot.agentAccessPolicy;
}

export function desktopAgentAccessPolicyCalls(serverId: string): AgentAccessPolicyCalls {
  const api = agentAccessPolicyPort();

  return {
    serverId,
    list: () => api.list(serverId),
    preview: (input) => api.preview(input, serverId),
    apply: (input) => api.apply(input, serverId),
  };
}
