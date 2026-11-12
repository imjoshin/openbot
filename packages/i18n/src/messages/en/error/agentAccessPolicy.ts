import { defineMessages } from "../../../message";

export const messages = defineMessages("error.agentAccessPolicy", {
  "error.agentAccessPolicy.invalid": "This agent group change is invalid.",
  "error.agentAccessPolicy.stale": "Agent permissions changed. Review the changes again.",
  "error.agentAccessPolicy.busy": "Wait until these agents are idle: {agents}.",
  "error.agentAccessPolicy.forbidden": "Only owners and admins can manage agent groups.",
  "error.agentAccessPolicy.connectionDenied": "This agent cannot use this MCP connection.",
  "error.agentAccessPolicy.refresh": "Permissions were saved. Wait for the agent to refresh its connections.",
  "error.agentAccessPolicy.storage": "Could not read or save agent permissions.",
});
