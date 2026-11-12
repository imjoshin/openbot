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

export const decodeAgentAccessPolicySnapshotFromMain = Schema.decodeUnknownSync(AgentAccessPolicySnapshotSchema);
export const decodeAgentAccessPolicyPreviewFromMain = Schema.decodeUnknownSync(AgentAccessPolicyPreviewSchema);
export const decodeAgentAccessPolicyApplyResultFromMain = Schema.decodeUnknownSync(AgentAccessPolicyApplyResultSchema);
export const decodeAgentCreatedWithAccessPolicyFromMain = guardedDecoder(isClientAgentSummary, "agent response");
export const decodeAgentAccessPolicyTransferOptionsFromMain = Schema.decodeUnknownSync(
  Schema.NullOr(AgentAccessPolicyTransferOptionsSchema),
);
export const decodeAgentAccessPolicyTransferPreviewFromMain = Schema.decodeUnknownSync(
  AgentAccessPolicyTransferPreviewSchema,
);
