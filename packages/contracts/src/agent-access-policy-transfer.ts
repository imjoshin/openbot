import { Schema } from "effect";
import { INPUT_LIMITS } from "./input-limits";
import { isAgentImportKey } from "./ipc-agent-import";
import { isIdentifier } from "./ipc-bounded-values";

const Id = Schema.String.check(Schema.isPattern(/^(?!__proto__$|constructor$|prototype$)[a-zA-Z0-9_-]{1,160}$/u));
const Key = Schema.declare(isAgentImportKey);
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Keys = Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(INPUT_LIMITS.agents));
const PolicyId = Schema.NullOr(Id);
const ConnectionIds = Schema.Array(Id).check(Schema.isMaxLength(INPUT_LIMITS.mcpServers + 1));
const selection = { token: Schema.declare(isIdentifier), keys: Keys };

export const AgentAccessPolicyTransferSelectionSchema = Schema.Struct(selection);
export type AgentAccessPolicyTransferSelection = typeof AgentAccessPolicyTransferSelectionSchema.Type;

export const AgentAccessPolicyTransferMappingSchema = Schema.Struct({
  ...selection,
  expectedRevision: Revision,
  agentMappings: Schema.Array(Schema.Struct({ key: Key, policyId: PolicyId })).check(
    Schema.isMaxLength(INPUT_LIMITS.agents),
  ),
  connectionMappings: Schema.Array(Schema.Struct({ sourceId: Id, destinationId: Id })).check(
    Schema.isMaxLength(INPUT_LIMITS.mcpServers + 1),
  ),
});
export type AgentAccessPolicyTransferMapping = typeof AgentAccessPolicyTransferMappingSchema.Type;

const Policy = Schema.Struct({ id: Id, name: Schema.String, allowNewConnections: Schema.Boolean });
const Connection = Schema.Struct({ id: Id, name: Schema.String, accountLabel: Schema.NullOr(Schema.String) });
export const AgentAccessPolicyTransferOptionsSchema = Schema.Struct({
  revision: Revision,
  agents: Schema.Array(Schema.Struct({ key: Key, name: Schema.String, sourcePolicyId: PolicyId })),
  sourcePolicies: Schema.Array(Policy),
  destinationPolicies: Schema.Array(Policy),
  sourceConnections: Schema.Array(Connection),
  destinationConnections: Schema.Array(Connection),
});
export type AgentAccessPolicyTransferOptions = typeof AgentAccessPolicyTransferOptionsSchema.Type;

export const AgentAccessPolicyTransferPreviewSchema = Schema.Struct({
  revision: Revision,
  agents: Schema.Array(
    Schema.Struct({
      key: Key,
      policyId: PolicyId,
      allowNewConnections: Schema.Boolean,
      enabledConnectionIds: ConnectionIds,
      disabledConnectionIds: ConnectionIds,
    }),
  ).check(Schema.isMaxLength(INPUT_LIMITS.agents)),
});
export type AgentAccessPolicyTransferPreview = typeof AgentAccessPolicyTransferPreviewSchema.Type;

export const decodeAgentAccessPolicyTransferSelection = Schema.decodeUnknownSync(
  AgentAccessPolicyTransferSelectionSchema,
);
export const decodeAgentAccessPolicyTransferMapping = Schema.decodeUnknownSync(AgentAccessPolicyTransferMappingSchema);
export const decodeAgentAccessPolicyTransferOptions = Schema.decodeUnknownSync(
  Schema.NullOr(AgentAccessPolicyTransferOptionsSchema),
);
export const decodeAgentAccessPolicyTransferPreview = Schema.decodeUnknownSync(AgentAccessPolicyTransferPreviewSchema);
