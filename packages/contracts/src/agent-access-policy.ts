import { Schema } from "effect";
import { INPUT_LIMITS } from "./input-limits";

export const AGENT_ACCESS_POLICY_LIMIT = 256;
export const AGENT_ACCESS_POLICY_NAME_LIMIT = 80;

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,160}$/u));
const ConnectionId = Id.check(Schema.isPattern(/^(?!__proto__$|constructor$|prototype$)/u));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PolicyId = Schema.NullOr(Id);
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(AGENT_ACCESS_POLICY_NAME_LIMIT));
export const AgentAccessPolicyChoicesSchema = Schema.Record(ConnectionId, Schema.Boolean);
export type AgentAccessPolicyChoices = typeof AgentAccessPolicyChoicesSchema.Type;

export const AgentAccessPolicySchema = Schema.Struct({
  id: Id,
  name: Name,
  revision: Revision,
  allowNewConnections: Schema.Boolean,
  choices: AgentAccessPolicyChoicesSchema,
});
export type AgentAccessPolicy = typeof AgentAccessPolicySchema.Type;

export const AgentAccessPolicyConnectionSchema = Schema.Struct({
  id: ConnectionId,
  name: Schema.String,
  accountLabel: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
});
export type AgentAccessPolicyConnection = typeof AgentAccessPolicyConnectionSchema.Type;

export const AgentAccessPolicyConnectionChoiceSchema = Schema.Struct({
  connectionId: ConnectionId,
  source: Schema.Literals(["default", "policy", "override"]),
  groupValue: Schema.NullOr(Schema.Boolean),
  override: Schema.NullOr(Schema.Boolean),
  allowed: Schema.Boolean,
  available: Schema.Boolean,
});
export type AgentAccessPolicyConnectionChoice = typeof AgentAccessPolicyConnectionChoiceSchema.Type;

export const AgentAccessPolicyAgentSchema = Schema.Struct({
  id: Id,
  name: Schema.String,
  policyId: PolicyId,
  overrides: AgentAccessPolicyChoicesSchema,
  connections: Schema.Array(AgentAccessPolicyConnectionChoiceSchema),
});
export type AgentAccessPolicyAgent = typeof AgentAccessPolicyAgentSchema.Type;

export const AgentAccessPolicySnapshotSchema = Schema.Struct({
  revision: Revision,
  policies: Schema.Array(AgentAccessPolicySchema),
  agents: Schema.Array(AgentAccessPolicyAgentSchema),
  connections: Schema.Array(AgentAccessPolicyConnectionSchema),
});
export type AgentAccessPolicySnapshot = typeof AgentAccessPolicySnapshotSchema.Type;

const Assignment = Schema.Struct({ agentId: Id, assigned: Schema.Boolean, keepOverrides: Schema.Boolean });
export const AgentAccessPolicyMutationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("savePolicy"),
    expectedRevision: Revision,
    policyId: PolicyId,
    name: Name,
    allowNewConnections: Schema.Boolean,
    choices: AgentAccessPolicyChoicesSchema,
    assignments: Schema.Array(Assignment).check(Schema.isMaxLength(INPUT_LIMITS.agents)),
  }),
  Schema.Struct({
    kind: Schema.Literal("deletePolicy"),
    expectedRevision: Revision,
    policyId: Id,
    destinationPolicyId: PolicyId,
  }),
  Schema.Struct({
    kind: Schema.Literal("assignAgent"),
    expectedRevision: Revision,
    agentId: Id,
    policyId: PolicyId,
    keepOverrides: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("setOverride"),
    expectedRevision: Revision,
    agentId: Id,
    connectionId: ConnectionId,
    allowed: Schema.NullOr(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("resetOverrides"),
    expectedRevision: Revision,
    agentId: Id,
  }),
]);
export type AgentAccessPolicyMutation = typeof AgentAccessPolicyMutationSchema.Type;

const PreviewChange = Schema.Struct({
  agentId: Id,
  enabledConnectionIds: Schema.Array(Id),
  disabledConnectionIds: Schema.Array(Id),
  overridesRemoved: Revision,
  overridesRetained: Revision,
});
export const AgentAccessPolicyPreviewSchema = Schema.Struct({
  revision: Revision,
  changes: Schema.Array(PreviewChange),
  overridesRemoved: Revision,
  overridesRetained: Revision,
});
export type AgentAccessPolicyPreview = typeof AgentAccessPolicyPreviewSchema.Type;

export const AgentAccessPolicyApplyResultSchema = Schema.Struct({
  status: Schema.Literals(["saved", "refreshPending"]),
  snapshot: AgentAccessPolicySnapshotSchema,
  agentIds: Schema.Array(Id),
});
export type AgentAccessPolicyApplyResult = typeof AgentAccessPolicyApplyResultSchema.Type;

export const AgentAccessPolicyCreateInputSchema = Schema.Struct({ policyId: PolicyId, expectedRevision: Revision });
export type AgentAccessPolicyActor = { role: "owner" | "admin" | "member"; userId: string };
export type AgentAccessPolicyCreateChoice = typeof AgentAccessPolicyCreateInputSchema.Type & {
  actor: AgentAccessPolicyActor;
};
