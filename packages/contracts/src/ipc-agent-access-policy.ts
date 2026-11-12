import { Schema } from "effect";
import {
  AgentAccessPolicyApplyResultSchema,
  AgentAccessPolicyMutationSchema,
  AgentAccessPolicyPreviewSchema,
  AgentAccessPolicySnapshotSchema,
} from "./agent-access-policy";
import { type CreateAgentInput, isClientAgentSummary } from "./ipc-agents";

export type CreateAgentWithAccessPolicyInput = {
  agent: CreateAgentInput;
  policyId: string;
  expectedRevision: number;
};

export const decodeAgentAccessPolicyMutation = Schema.decodeUnknownSync(AgentAccessPolicyMutationSchema);
export const decodeAgentAccessPolicySnapshot = Schema.decodeUnknownSync(AgentAccessPolicySnapshotSchema);
export const decodeAgentAccessPolicyPreview = Schema.decodeUnknownSync(AgentAccessPolicyPreviewSchema);
export const decodeAgentAccessPolicyApplyResult = Schema.decodeUnknownSync(AgentAccessPolicyApplyResultSchema);

export function decodeAgentCreatedWithAccessPolicy(value: unknown) {
  if (!isClientAgentSummary(value)) throw new Error("Invalid agent.");
  return value;
}
