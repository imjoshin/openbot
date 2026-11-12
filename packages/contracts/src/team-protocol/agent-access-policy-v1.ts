// Frozen optional policy contract. The host restricts these routes to owners and admins.
import { isDynamicRecord } from "../runtime-values";
import { TEAM_API_ROUTES } from "../team-api-routes";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
  variant,
} from "./admin-wire";
import { toCurrentAgentKeys, toWireAgentKeys } from "./current-agent-keys";
import { decodeTeamProtocolV8BaseHttpResponse } from "./v8-base";

export const AGENT_ACCESS_POLICY_CAPABILITY = "agent-access-policy-v1";
export const AGENT_ACCESS_POLICY_ROUTES = {
  list: "/v1/agent-access-policies",
  preview: "/v1/agent-access-policies/preview",
  apply: "/v1/agent-access-policies/apply",
  createAgent: "/v1/agent-access-policies/create-agent",
  getTransferMapping: "/v1/agent-access-policies/transfer-mapping",
  previewTransferMapping: "/v1/agent-access-policies/transfer-mapping/preview",
  applyTransferMapping: "/v1/agent-access-policies/transfer-mapping/apply",
} as const;

const id: AdminDecoder = (value) => {
  if (typeof value !== "string" || !/^(?!__proto__$|constructor$|prototype$)[a-zA-Z0-9_-]{1,160}$/u.test(value)) {
    throw new Error("Invalid agent access policy identifier.");
  }
  return value;
};
const policyId = nullable(id);
const name = string(80);
const choices: AdminDecoder = (value) => {
  if (!isDynamicRecord(value)) throw new Error("Invalid agent access policy choices.");
  const entries = Object.entries(value);
  if (entries.length > 4096) throw new Error("Invalid agent access policy choices.");
  return Object.fromEntries(entries.map(([key, choice]) => [String(id(key)), boolean(choice)]));
};
const assignment = fields({ agentId: id, assigned: boolean, keepOverrides: boolean });
const mutation = variant({
  savePolicy: fields({
    kind: oneOf("savePolicy"),
    expectedRevision: count,
    policyId,
    name,
    allowNewConnections: boolean,
    choices,
    assignments: list(assignment, 4096),
  }),
  deletePolicy: fields({
    kind: oneOf("deletePolicy"),
    expectedRevision: count,
    policyId: id,
    destinationPolicyId: policyId,
  }),
  assignAgent: fields({
    kind: oneOf("assignAgent"),
    expectedRevision: count,
    agentId: id,
    policyId,
    keepOverrides: boolean,
  }),
  setOverride: fields({
    kind: oneOf("setOverride"),
    expectedRevision: count,
    agentId: id,
    connectionId: id,
    allowed: nullable(boolean),
  }),
  resetOverrides: fields({ kind: oneOf("resetOverrides"), expectedRevision: count, agentId: id }),
});
const connection = fields({ id, name: string(1024), accountLabel: nullable(string(1024)), available: boolean });
const resolution = fields({
  connectionId: id,
  source: oneOf("default", "policy", "override"),
  groupValue: nullable(boolean),
  override: nullable(boolean),
  allowed: boolean,
  available: boolean,
});
const snapshot = fields({
  revision: count,
  policies: list(fields({ id, name, revision: count, allowNewConnections: boolean, choices }), 256),
  agents: list(
    fields({ id, name: string(1024), policyId, overrides: choices, connections: list(resolution, 4096) }),
    4096,
  ),
  connections: list(connection, 4096),
});
const preview = fields({
  revision: count,
  changes: list(
    fields({
      agentId: id,
      enabledConnectionIds: list(id, 4096),
      disabledConnectionIds: list(id, 4096),
      overridesRemoved: count,
      overridesRetained: count,
    }),
    4096,
  ),
  overridesRemoved: count,
  overridesRetained: count,
});
const apply = fields({ status: oneOf("saved", "refreshPending"), snapshot, agentIds: list(id, 4096) });

const createAgent = fields({
  policyId: id,
  expectedRevision: count,
  agent: fields(
    {
      name: string(200),
      description: string(2000),
      avatarSeed: string(128),
      avatarHue: nullable(count),
      initialMessage: string(100_000),
    },
    {
      avatarColor: nullable(string(128)),
      provider: string(128),
      model: string(1024),
      reasoningEffort: string(128),
      providerAccountId: string(160),
    },
  ),
});

// Reuse the frozen v8 projection for a newly created agent. That projection exposes no policy data.
const createdAgent: AdminDecoder = (value) => {
  const path = TEAM_API_ROUTES.agents.all;
  const wire = toWireAgentKeys(JSON.parse(JSON.stringify(value)));
  return toCurrentAgentKeys(decodeTeamProtocolV8BaseHttpResponse("POST", path, 201, wire));
};

const transferKey = string(64);
const transferSelectionFields = { token: identifier, keys: list(transferKey, 100) };
const transferPolicy = fields({ id, name, allowNewConnections: boolean });
const transferConnection = fields({ id, name: string(1024), accountLabel: nullable(string(1024)) });
const transferOptions = fields({
  revision: count,
  agents: list(fields({ key: transferKey, name, sourcePolicyId: policyId }), 100),
  sourcePolicies: list(transferPolicy, 256),
  destinationPolicies: list(transferPolicy, 256),
  sourceConnections: list(transferConnection, 101),
  destinationConnections: list(transferConnection, 101),
});
const transferMappingFields = {
  ...transferSelectionFields,
  expectedRevision: count,
  agentMappings: list(fields({ key: transferKey, policyId }), 100),
  connectionMappings: list(fields({ sourceId: id, destinationId: id }), 101),
};
const transferPreview = fields({
  revision: count,
  agents: list(
    fields({
      key: transferKey,
      policyId,
      allowNewConnections: boolean,
      enabledConnectionIds: list(id, 101),
      disabledConnectionIds: list(id, 101),
    }),
    100,
  ),
});
const transferResult = fields({
  agents: list(fields({ agentId: identifier, name }), 100),
  skipped: list(fields({ key: transferKey, name, reason: string(500) }), 100),
  signIn: list(string(32), 32),
  warnings: list(string(500), 200),
});

export const AGENT_ACCESS_POLICY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [AGENT_ACCESS_POLICY_ROUTES.list, adminRoute(empty, snapshot)],
  [AGENT_ACCESS_POLICY_ROUTES.preview, adminRoute(mutation, preview)],
  [AGENT_ACCESS_POLICY_ROUTES.apply, adminRoute(mutation, apply)],
  [AGENT_ACCESS_POLICY_ROUTES.createAgent, adminRoute(createAgent, createdAgent)],
  [
    AGENT_ACCESS_POLICY_ROUTES.getTransferMapping,
    adminRoute(fields(transferSelectionFields), nullable(transferOptions)),
  ],
  [AGENT_ACCESS_POLICY_ROUTES.previewTransferMapping, adminRoute(fields(transferMappingFields), transferPreview)],
  [
    AGENT_ACCESS_POLICY_ROUTES.applyTransferMapping,
    adminRoute(fields(transferMappingFields, { timezone: string(255) }), transferResult),
  ],
]);
