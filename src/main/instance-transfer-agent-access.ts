import {
  AgentAccessPolicyChoicesSchema,
  AgentAccessPolicySchema,
  type AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import type {
  AgentAccessPolicyTransferMapping,
  AgentAccessPolicyTransferPreview,
} from "@openbot/contracts/agent-access-policy-transfer";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isAgentImportKey } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";
import type { AgentAccessPolicyMembership } from "../backend/database/agent-access-policy-store";

const Id = Schema.String.check(Schema.isPattern(/^(?!__proto__$|constructor$|prototype$)[a-zA-Z0-9_-]{1,160}$/u));

export const TransferAgentAccess = Schema.Struct({
  policies: Schema.Array(AgentAccessPolicySchema).check(Schema.isMaxLength(256)),
  memberships: Schema.Array(
    Schema.Struct({
      key: Schema.declare(isAgentImportKey),
      policyId: Schema.NullOr(Id),
      overrides: AgentAccessPolicyChoicesSchema,
    }),
  ).check(Schema.isMaxLength(INPUT_LIMITS.agents)),
  connectionIds: Schema.Array(Id).check(Schema.isMaxLength(INPUT_LIMITS.mcpServers + 1)),
  connectionNames: Schema.Record(Id, Schema.String.check(Schema.isMaxLength(1024))),
});

export type TransferAgentAccessData = typeof TransferAgentAccess.Type;

export function validTransferAgentAccess(data: TransferAgentAccessData, keys: ReadonlySet<string>): boolean {
  const policyIds = new Set(data.policies.map(({ id }) => id));
  const memberKeys = new Set(data.memberships.map(({ key }) => key));
  return (
    policyIds.size === data.policies.length &&
    memberKeys.size === data.memberships.length &&
    new Set(data.connectionIds).size === data.connectionIds.length &&
    data.connectionIds.length === Object.keys(data.connectionNames).length &&
    data.connectionIds.every((id) => Object.hasOwn(data.connectionNames, id)) &&
    [...keys].every((key) => memberKeys.has(key)) &&
    data.memberships.every(({ policyId }) => policyId === null || policyIds.has(policyId))
  );
}

export function policyMappingRequired(): Error {
  return new Error(sourceText("error.import.transferAgentAccessMappingRequired"));
}

export function buildAgentAccessTransferMapping(
  data: TransferAgentAccessData,
  destination: AgentAccessPolicySnapshot,
  input: AgentAccessPolicyTransferMapping,
) {
  if (destination.revision !== input.expectedRevision) throw new Error(sourceText("error.agentAccessPolicy.stale"));
  const groupById = new Map(destination.policies.map((policy) => [policy.id, policy]));
  const sourceGroupById = new Map(data.policies.map((policy) => [policy.id, policy]));
  const members = new Map(data.memberships.map((member) => [member.key, member]));
  const assignments = new Map(input.agentMappings.map(({ key, policyId }) => [key, policyId]));
  const connections = new Map(input.connectionMappings.map(({ sourceId, destinationId }) => [destinationId, sourceId]));
  const sourceIds = new Set(input.connectionMappings.map(({ sourceId }) => sourceId));
  const connectionIds = destination.connections.map(({ id }) => id);
  if (
    assignments.size !== input.agentMappings.length ||
    assignments.size !== input.keys.length ||
    input.keys.some((key) => !assignments.has(key) || !members.has(key)) ||
    connections.size !== input.connectionMappings.length ||
    sourceIds.size !== data.connectionIds.length ||
    connections.size !== sourceIds.size ||
    data.connectionIds.some((id) => !sourceIds.has(id)) ||
    [...connections.keys()].some((id) => !connectionIds.includes(id))
  )
    throw policyMappingRequired();

  const memberships = new Map<string, { membership: AgentAccessPolicyMembership; policyRevision: number | null }>();
  const agents: AgentAccessPolicyTransferPreview["agents"][number][] = [];
  for (const key of input.keys) {
    const policyId = assignments.get(key);
    const source = members.get(key);
    if (policyId === undefined || !source) throw policyMappingRequired();
    const group = policyId === null ? null : groupById.get(policyId);
    const sourceGroup = source.policyId === null ? null : sourceGroupById.get(source.policyId);
    if (group === undefined || sourceGroup === undefined) throw policyMappingRequired();
    const overrides = new Map<string, boolean>();
    const enabledConnectionIds: string[] = [];
    const disabledConnectionIds: string[] = [];
    for (const id of connectionIds) {
      const sourceId = connections.get(id);
      const explicit =
        sourceId !== undefined && Object.hasOwn(source.overrides, sourceId) ? source.overrides[sourceId] : undefined;
      const allowed =
        sourceId === undefined ? false : (explicit ?? (sourceGroup === null || sourceGroup.choices[sourceId] === true));
      const inherited = group === null || group.choices[id] === true;
      if (sourceId === undefined || explicit !== undefined || allowed !== inherited) overrides.set(id, allowed);
      (allowed ? enabledConnectionIds : disabledConnectionIds).push(id);
    }
    const membership = { policyId, overrides: Object.fromEntries(overrides) };
    memberships.set(key, { membership, policyRevision: group?.revision ?? null });
    agents.push({
      key,
      policyId,
      allowNewConnections: group?.allowNewConnections ?? true,
      enabledConnectionIds,
      disabledConnectionIds,
    });
  }
  const preview: AgentAccessPolicyTransferPreview = { revision: destination.revision, agents };
  return { preview, memberships, connectionIds };
}
