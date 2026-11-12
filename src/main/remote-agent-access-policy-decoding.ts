import {
  AgentAccessPolicyApplyResultSchema,
  AgentAccessPolicyPreviewSchema,
  AgentAccessPolicySnapshotSchema,
} from "@openbot/contracts/agent-access-policy";
import {
  AgentAccessPolicyTransferOptionsSchema,
  AgentAccessPolicyTransferPreviewSchema,
} from "@openbot/contracts/agent-access-policy-transfer";
import { isClientAgentSummary } from "@openbot/contracts/ipc";
import { guardedDecoder } from "@openbot/contracts/ipc-decoding";
import { Schema } from "effect";

export const decodeAgentAccessPolicySnapshotFromHost = Schema.decodeUnknownSync(AgentAccessPolicySnapshotSchema);
export const decodeAgentAccessPolicyPreviewFromHost = Schema.decodeUnknownSync(AgentAccessPolicyPreviewSchema);
export const decodeAgentAccessPolicyApplyResultFromHost = Schema.decodeUnknownSync(AgentAccessPolicyApplyResultSchema);
export const decodeAgentCreatedWithAccessPolicyFromHost = guardedDecoder(isClientAgentSummary, "agent response");
export const decodeAgentAccessPolicyTransferOptionsFromHost = Schema.decodeUnknownSync(
  Schema.NullOr(AgentAccessPolicyTransferOptionsSchema),
);
export const decodeAgentAccessPolicyTransferPreviewFromHost = Schema.decodeUnknownSync(
  AgentAccessPolicyTransferPreviewSchema,
);
