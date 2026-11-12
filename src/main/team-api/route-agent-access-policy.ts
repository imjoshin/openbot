import type { AgentAccessPolicyMutation, AgentAccessPolicySnapshot } from "@openbot/contracts/agent-access-policy";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  AGENT_ACCESS_POLICY_CAPABILITY,
  AGENT_ACCESS_POLICY_ROUTES,
} from "@openbot/contracts/team-protocol/agent-access-policy-v1";
import { TEAM_PROTOCOL_V9 } from "@openbot/contracts/team-protocol/v9";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type { AgentAccessPolicyFailed } from "../../backend/agent/agent-access-policy";
import { parseAgentAccessPolicyMutation } from "../ipc/agent-access-policy-inputs";
import { memberAuditName } from "../server-audit-store";
import type { TeamApiAgentAccessPolicy, TeamApiServerAudit } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

export function requireAgentAccessPolicy(
  context: TeamApiRequestContext,
  service: TeamApiAgentAccessPolicy | undefined,
): asserts service is TeamApiAgentAccessPolicy {
  requireAdmin(context.member);
  if (!service || context.protocol < TEAM_PROTOCOL_V9 || !context.capabilities.has(AGENT_ACCESS_POLICY_CAPABILITY)) {
    throw new HttpError(400, sourceText("error.team.agentAccessPolicyUnsupported"));
  }
}

export async function readAgentAccessPolicyInput<A>(
  context: TeamApiRequestContext,
  parse: (body: DynamicRecord) => A,
): Promise<A> {
  try {
    return parse(await readJson(context.request));
  } catch (error) {
    if (error instanceof HttpError && error.status !== 400) throw error;
    throw new HttpError(400, sourceText("error.team.agentAccessPolicyInvalid"), "protocol_error");
  }
}

export function agentAccessPolicyHttpError(
  error: AgentAccessPolicyFailed,
  hiddenAgentIds: ReadonlySet<string>,
): HttpError {
  const status = { invalid: 400, stale: 409, busy: 409, forbidden: 403, refresh: 503, storage: 500 }[error.code];
  const hidden = error.agentIds.some((id) => hiddenAgentIds.has(id));
  return new HttpError(status, hidden ? sourceText("error.team.requestFailed") : error.message);
}

async function runPolicy<A>(
  operation: Effect.Effect<A, AgentAccessPolicyFailed>,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw agentAccessPolicyHttpError(result.failure, hiddenAgentIds);
  return result.success;
}

function visibleSnapshot(
  snapshot: AgentAccessPolicySnapshot,
  hiddenAgentIds: ReadonlySet<string>,
): AgentAccessPolicySnapshot {
  return { ...snapshot, agents: snapshot.agents.filter((agent) => !hiddenAgentIds.has(agent.id)) };
}

function requireVisibleTargets(
  mutation: AgentAccessPolicyMutation,
  hiddenAgentIds: ReadonlySet<string>,
  listAgents: () => readonly { id: string }[],
): void {
  const targets =
    "agentId" in mutation
      ? [mutation.agentId]
      : mutation.kind === "savePolicy"
        ? mutation.assignments.map(({ agentId }) => agentId)
        : [];
  if (targets.length === 0) return;
  const agentIds = new Set(listAgents().map(({ id }) => id));
  if (targets.some((id) => hiddenAgentIds.has(id) || !agentIds.has(id))) {
    throw new HttpError(404, sourceText("error.team.agentNotFound"));
  }
}

export function recordPolicyChange(
  context: TeamApiRequestContext,
  audit: TeamApiServerAudit | undefined,
  serverId: string | undefined,
): Promise<void> {
  if (!audit?.record || !serverId) return Promise.resolve();
  return Effect.runPromise(
    audit.record(serverId, memberAuditName(context.member), [{ change: { kind: "agent-access-policy" } }]),
  );
}

export async function routeAgentAccessPolicy(
  context: TeamApiRequestContext,
  service: TeamApiAgentAccessPolicy | undefined,
  audit: TeamApiServerAudit | undefined,
  serverId: string | undefined,
  hiddenAgentIds: ReadonlySet<string>,
  listAgents: () => readonly { id: string }[],
): Promise<RouteOutcome> {
  const { method, url, member, json } = context;
  const { list, preview, apply } = AGENT_ACCESS_POLICY_ROUTES;
  const path = url.pathname;
  if (method !== "POST" || (path !== list && path !== preview && path !== apply)) return "unmatched";
  requireAgentAccessPolicy(context, service);
  const actor = { userId: member.id, role: member.role };
  if (path === list) {
    await readAgentAccessPolicyInput(context, (body) => body);
    return json(200, visibleSnapshot(await runPolicy(service.read(actor), hiddenAgentIds), hiddenAgentIds));
  }
  const mutation = await readAgentAccessPolicyInput(context, parseAgentAccessPolicyMutation);
  requireVisibleTargets(mutation, hiddenAgentIds, listAgents);
  if (path === preview) {
    const result = await runPolicy(service.preview(mutation, actor), hiddenAgentIds);
    const changes = result.changes.filter(({ agentId }) => !hiddenAgentIds.has(agentId));
    return json(200, {
      revision: result.revision,
      changes,
      overridesRemoved: changes.reduce((sum, change) => sum + change.overridesRemoved, 0),
      overridesRetained: changes.reduce((sum, change) => sum + change.overridesRetained, 0),
    });
  }
  if (path === apply) {
    const result = await runPolicy(service.apply(mutation, actor), hiddenAgentIds);
    await recordPolicyChange(context, audit, serverId);
    return json(200, {
      ...result,
      snapshot: visibleSnapshot(result.snapshot, hiddenAgentIds),
      agentIds: result.agentIds.filter((id) => !hiddenAgentIds.has(id)),
    });
  }
  return "unmatched";
}
