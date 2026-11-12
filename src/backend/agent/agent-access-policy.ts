import { randomUUID } from "node:crypto";
import {
  AGENT_ACCESS_POLICY_LIMIT,
  type AgentAccessPolicy,
  type AgentAccessPolicyActor,
  type AgentAccessPolicyApplyResult,
  type AgentAccessPolicyConnection,
  type AgentAccessPolicyConnectionChoice,
  type AgentAccessPolicyCreateChoice,
  type AgentAccessPolicyMutation,
  type AgentAccessPolicyPreview,
  type AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import { COMPUTER_USE_MCP_SERVER_ID } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema, Semaphore } from "effect";
import {
  type AgentAccessPolicyMembership,
  type AgentAccessPolicyStore,
  DEFAULT_MCP_MEMBERSHIP,
} from "../database/agent-access-policy-store";

type Agent = { id: string; name: string };
type PolicyState = {
  revision: number;
  connections: readonly AgentAccessPolicyConnection[];
  policies: Map<string, AgentAccessPolicy>;
  agents: readonly Agent[];
  memberships: Map<string, AgentAccessPolicyMembership>;
};

type PolicyFailureCode = typeof FailureCode.Type;
const FailureCode = Schema.Literals(["invalid", "stale", "busy", "forbidden", "refresh", "storage"]);

export class AgentAccessPolicyFailed extends Schema.TaggedError<AgentAccessPolicyFailed>()("AgentAccessPolicyFailed", {
  code: FailureCode,
  message: Schema.String,
  agentIds: Schema.Array(Schema.String),
}) {}

function failure(code: Exclude<PolicyFailureCode, "busy">): AgentAccessPolicyFailed {
  const messages = {
    invalid: sourceText("error.agent.accessPolicy.invalid"),
    stale: sourceText("error.agent.accessPolicy.stale"),
    forbidden: sourceText("error.agent.accessPolicy.forbidden"),
    refresh: sourceText("error.agent.accessPolicy.refresh"),
    storage: sourceText("error.agent.accessPolicy.storage"),
  };

  return new AgentAccessPolicyFailed({ code, message: messages[code], agentIds: [] });
}

function failedBusy(agents: readonly Agent[]): AgentAccessPolicyFailed {
  return new AgentAccessPolicyFailed({
    code: "busy",
    message: sourceText("error.agent.accessPolicy.busy", { agents: agents.map((agent) => agent.name).join(", ") }),
    agentIds: agents.map((agent) => agent.id),
  });
}

function policyStep<A>(tryRun: () => A): Effect.Effect<A, AgentAccessPolicyFailed> {
  return Effect.try({
    try: tryRun,
    catch: (cause) => (cause instanceof AgentAccessPolicyFailed ? cause : failure("storage")),
  });
}

export interface AgentAccessPolicyControllerOptions {
  store: AgentAccessPolicyStore;
  agents(): readonly Agent[];
  connections(): readonly AgentAccessPolicyConnection[];
  busy(agentId: string): boolean;
  refresh(agentId: string, startingDeliveryIds?: ReadonlySet<string>): Effect.Effect<boolean, unknown>;
  invalidate?(agentId: string): void;
}

/** Owns authorization, policy resolution, atomic edits and the provider refresh barrier. */
export class AgentAccessPolicyController {
  readonly #mutations = Semaphore.makeUnsafe(1);
  readonly #refreshQueue = Semaphore.makeUnsafe(1);

  constructor(private readonly options: AgentAccessPolicyControllerOptions) {}

  read(actor: AgentAccessPolicyActor): Effect.Effect<AgentAccessPolicySnapshot, AgentAccessPolicyFailed> {
    return policyStep(() => {
      requireAdmin(actor);

      return snapshot(this.#readState());
    });
  }

  preview(mutation: AgentAccessPolicyMutation, actor: AgentAccessPolicyActor) {
    return policyStep(() => {
      requireAdmin(actor);

      const before = this.#readState();
      const after = planMutation(before, mutation);
      return describeChanges(before, after).preview;
    });
  }

  importPolicies(policies: readonly AgentAccessPolicy[], actor: AgentAccessPolicyActor) {
    return policyStep(() => {
      requireAdmin(actor);

      const { store } = this.options;
      return store.transaction(() => {
        const before = this.#readState();
        if (before.policies.size + policies.length > AGENT_ACCESS_POLICY_LIMIT) throw failure("invalid");

        const names = new Set([...before.policies.values()].map(({ name }) => name.toLowerCase()));
        const mapping = new Map<string, string>();

        for (const policy of policies) {
          if (mapping.has(policy.id) || names.has(policy.name.toLowerCase())) throw failure("invalid");

          const id = randomUUID();
          names.add(policy.name.toLowerCase());
          mapping.set(policy.id, id);
          store.savePolicy({
            ...policy,
            id,
            revision: 1,
            choices: { ...Object.fromEntries(before.connections.map(({ id }) => [id, false])), ...policy.choices },
          });
        }

        if (mapping.size > 0) store.advanceRevision();
        return mapping;
      });
    });
  }

  apply(mutation: AgentAccessPolicyMutation, actor: AgentAccessPolicyActor) {
    return this.#mutations.withPermit(this.#apply(mutation, actor));
  }

  readonly #apply = Effect.fn("AgentAccessPolicy.apply")(function* (
    this: AgentAccessPolicyController,
    mutation: AgentAccessPolicyMutation,
    actor: AgentAccessPolicyActor,
  ): Effect.fn.Return<AgentAccessPolicyApplyResult, AgentAccessPolicyFailed> {
    const { store } = this.options;
    const { state, affectedIds } = yield* policyStep(() => {
      requireAdmin(actor);
      // Updating the catalog observation can advance the revision before the edit is planned.
      const before = this.#readState();
      return store.transaction(() => {
        const after = planMutation(before, mutation);
        const { affectedIds } = describeChanges(before, after);
        const busy = before.agents.filter((agent) => affectedIds.includes(agent.id) && this.options.busy(agent.id));
        if (busy.length > 0) throw failedBusy(busy);

        for (const [id, policy] of after.policies) {
          if (before.policies.get(id) !== policy) store.savePolicy(policy);
        }
        for (const [id, membership] of after.memberships) {
          if (before.memberships.get(id) !== membership) store.saveMembership(id, membership);
        }
        for (const id of before.policies.keys()) {
          if (!after.policies.has(id)) store.deletePolicy(id);
        }

        const revision = store.advanceRevision();
        for (const id of affectedIds) store.markRefresh(id, revision);
        return { state: { ...after, revision }, affectedIds };
      });
    });

    for (const id of affectedIds) this.options.invalidate?.(id);

    const pending: string[] = [];
    for (const id of affectedIds) {
      const refreshed = yield* Effect.result(this.ensureReady(id));
      if (Result.isFailure(refreshed)) pending.push(id);
    }

    return { status: pending.length > 0 ? "refreshPending" : "saved", snapshot: snapshot(state), agentIds: pending };
  }, Effect.uninterruptible);

  /** Both policy and availability must permit the connection at the time of use. */
  allows(agentId: string, connectionId: string): boolean {
    try {
      if (connectionId === COMPUTER_USE_MCP_SERVER_ID) return true;
      const connection = this.options.connections().find(({ id }) => id === connectionId);
      return connection?.available === true && this.#allowsPolicy(agentId, connection);
    } catch {
      return false;
    }
  }

  /** Management may show an allowed row while the connection is off or disconnected. */
  permits(agentId: string, connectionId: string): boolean {
    try {
      if (connectionId === COMPUTER_USE_MCP_SERVER_ID) return true;
      const connection = this.options.connections().find(({ id }) => id === connectionId);
      return connection !== undefined && this.#allowsPolicy(agentId, connection);
    } catch {
      return false;
    }
  }

  #allowsPolicy(agentId: string, connection: AgentAccessPolicyConnection): boolean {
    const membership = this.restriction(agentId);
    const policy = membership.policyId === null ? null : this.options.store.policy(membership.policyId);
    if (membership.policyId !== null && policy === null) return false;
    return resolveChoice(membership, policy, connection).allowed;
  }

  restriction(agentId: string): AgentAccessPolicyMembership {
    if (!this.options.agents().some(({ id }) => id === agentId)) throw failure("invalid");

    const membership = this.options.store.membership(agentId);
    if (membership.policyId !== null && !this.options.store.policy(membership.policyId)) throw failure("invalid");
    return membership;
  }

  allowsNewConnection(agentId: string): boolean {
    try {
      const { policyId } = this.restriction(agentId);
      return policyId === null || this.options.store.policy(policyId)?.allowNewConnections === true;
    } catch {
      return false;
    }
  }

  filter<T extends { id: string }>(agentId: string, configs: readonly T[]): T[] {
    try {
      const membership = this.restriction(agentId);
      const policy = membership.policyId === null ? null : this.options.store.policy(membership.policyId);
      const available = new Map(this.options.connections().map((connection) => [connection.id, connection]));

      return configs.filter(({ id }) => {
        if (id === COMPUTER_USE_MCP_SERVER_ID) return true;
        const connection = available.get(id);
        return connection?.available === true && resolveChoice(membership, policy, connection).allowed;
      });
    } catch {
      return configs.filter(({ id }) => id === COMPUTER_USE_MCP_SERVER_ID);
    }
  }

  assertReady(agentId: string): void {
    if (this.options.store.pendingRefresh(agentId) !== null) throw failure("refresh");
  }

  /** The roster calls this again in its creation transaction, before it publishes the new agent. */
  forCreation(choice: AgentAccessPolicyCreateChoice): AgentAccessPolicyMembership {
    requireAdmin(choice.actor);

    const current = this.#readState();
    if (current.revision !== choice.expectedRevision) throw failure("stale");
    requirePolicy(current, choice.policyId);
    return { policyId: choice.policyId, overrides: {} };
  }

  /** Validates the destination mapping again inside the new agent's roster transaction. */
  forMappedCreation(
    membership: AgentAccessPolicyMembership,
    baseline: { policyRevision: number | null; connectionIds: readonly string[]; expectedRevision?: number },
  ): AgentAccessPolicyMembership {
    const current = this.#readState();
    if (baseline.expectedRevision !== undefined && baseline.expectedRevision !== current.revision)
      throw failure("stale");

    const policy = membership.policyId === null ? null : current.policies.get(membership.policyId);
    if ((policy?.revision ?? null) !== baseline.policyRevision || (membership.policyId !== null && !policy))
      throw failure("stale");

    const connectionIds = new Set(baseline.connectionIds);
    if (
      connectionIds.size !== current.connections.length ||
      current.connections.some(({ id }) => !connectionIds.has(id))
    )
      throw failure("stale");

    return membership;
  }

  readonly ensureReady = Effect.fn("AgentAccessPolicy.ensureReady")(function* (
    this: AgentAccessPolicyController,
    agentId: string,
    startingDeliveryIds?: ReadonlySet<string>,
  ) {
    const { store } = this.options;
    if ((yield* policyStep(() => store.pendingRefresh(agentId))) === null) return;

    yield* this.#refreshQueue.withPermit(
      Effect.gen({ self: this }, function* () {
        const revision = yield* policyStep(() => store.pendingRefresh(agentId));
        if (revision === null) return;

        const result = yield* Effect.result(
          this.options
            .refresh(agentId, startingDeliveryIds)
            .pipe(Effect.catchDefect(() => Effect.fail(failure("refresh")))),
        );
        if (Result.isFailure(result) || !result.success) return yield* failure("refresh");

        yield* policyStep(() => store.finishRefresh(agentId, revision));
        if ((yield* policyStep(() => store.pendingRefresh(agentId))) !== null) return yield* failure("refresh");
      }),
    );
  }, Effect.uninterruptible).bind(this);

  #readState(): PolicyState {
    const { store } = this.options;
    const agents = this.options.agents();
    const connections = this.options.connections();

    // A sign-in or disconnect invalidates an open preview.
    store.observeConnections(JSON.stringify(connections.map(({ id, available }) => [id, available]).sort()));

    const policies = store.policies();
    const memberships = new Map(agents.map(({ id }) => [id, store.membership(id)]));
    const state = { revision: store.revision(), connections, policies, agents, memberships };
    for (const { policyId } of memberships.values()) requirePolicy(state, policyId);
    return state;
  }
}

function requireAdmin(actor: AgentAccessPolicyActor): void {
  if (actor.role !== "owner" && actor.role !== "admin") throw failure("forbidden");
}

function requirePolicy(state: PolicyState, id: string | null): AgentAccessPolicy | null {
  if (id === null) return null;
  const policy = state.policies.get(id);
  if (!policy) throw failure("invalid");
  return policy;
}

function requireMembership(state: PolicyState, agentId: string): AgentAccessPolicyMembership {
  const membership = state.memberships.get(agentId);
  if (!membership) throw failure("invalid");
  return membership;
}

function resolveChoice(
  membership: AgentAccessPolicyMembership,
  policy: AgentAccessPolicy | null,
  connection: AgentAccessPolicyConnection,
): AgentAccessPolicyConnectionChoice {
  const override = Object.hasOwn(membership.overrides, connection.id)
    ? (membership.overrides[connection.id] ?? null)
    : null;
  const groupValue = policy
    ? Object.hasOwn(policy.choices, connection.id) && policy.choices[connection.id] === true
    : null;

  return {
    connectionId: connection.id,
    source: override !== null ? "override" : policy ? "policy" : "default",
    groupValue,
    override,
    allowed: override ?? groupValue ?? true,
    available: connection.available,
  };
}

function snapshot(state: PolicyState): AgentAccessPolicySnapshot {
  return {
    revision: state.revision,
    policies: [...state.policies.values()],
    connections: state.connections,
    agents: state.agents.map(({ id, name }) => {
      const membership = requireMembership(state, id);
      const policy = requirePolicy(state, membership.policyId);
      return {
        id,
        name,
        ...membership,
        connections: state.connections.map((connection) => resolveChoice(membership, policy, connection)),
      };
    }),
  };
}

function assign(
  state: PolicyState,
  before: PolicyState,
  agentId: string,
  policyId: string | null,
  keepOverrides: boolean,
): void {
  const current = requireMembership(state, agentId);
  if (current.policyId === policyId) return;

  if (policyId !== null) {
    requirePolicy(state, policyId);
    state.memberships.set(agentId, { policyId, overrides: keepOverrides ? current.overrides : {} });
    return;
  }

  const old = requirePolicy(before, current.policyId);
  const ids = new Set([
    ...state.connections.map(({ id }) => id),
    ...Object.keys(old?.choices ?? {}),
    ...Object.keys(current.overrides),
  ]);
  const denied = [...ids].filter(
    (id) => !resolveChoice(current, old, { id, name: "", accountLabel: null, available: false }).allowed,
  );
  state.memberships.set(agentId, { policyId, overrides: Object.fromEntries(denied.map((id) => [id, false])) });
}

function planMutation(before: PolicyState, mutation: AgentAccessPolicyMutation): PolicyState {
  if (before.revision !== mutation.expectedRevision) throw failure("stale");

  const after = { ...before, policies: new Map(before.policies), memberships: new Map(before.memberships) };
  const connectionIds = new Set(before.connections.map(({ id }) => id));

  switch (mutation.kind) {
    case "savePolicy": {
      const existing = requirePolicy(after, mutation.policyId);
      if (!existing && before.policies.size >= AGENT_ACCESS_POLICY_LIMIT) throw failure("invalid");

      const name = mutation.name.trim();
      if (
        !name ||
        [...before.policies.values()].some(
          (policy) => policy.id !== existing?.id && policy.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw failure("invalid");
      if (Object.keys(mutation.choices).some((id) => !connectionIds.has(id))) throw failure("invalid");

      const id = existing?.id ?? randomUUID();
      const choices = {
        ...existing?.choices,
        ...Object.fromEntries(
          [...connectionIds].map((connectionId) => [connectionId, existing?.choices[connectionId] ?? false]),
        ),
        ...mutation.choices,
      };
      after.policies.set(id, {
        id,
        name,
        choices,
        allowNewConnections: mutation.allowNewConnections,
        revision: (existing?.revision ?? 0) + 1,
      });

      const seen = new Set<string>();
      for (const { agentId, assigned, keepOverrides } of mutation.assignments) {
        const membership = requireMembership(after, agentId);
        if (seen.has(agentId) || (!assigned && membership.policyId !== id)) throw failure("invalid");
        seen.add(agentId);
        assign(after, before, agentId, assigned ? id : null, keepOverrides);
      }
      break;
    }
    case "deletePolicy":
      requirePolicy(after, mutation.policyId);
      requirePolicy(after, mutation.destinationPolicyId);
      if (mutation.destinationPolicyId === mutation.policyId) throw failure("invalid");

      for (const [agentId, membership] of after.memberships) {
        if (membership.policyId === mutation.policyId)
          assign(after, before, agentId, mutation.destinationPolicyId, false);
      }
      after.policies.delete(mutation.policyId);
      break;
    case "assignAgent":
      assign(after, before, mutation.agentId, mutation.policyId, mutation.keepOverrides);
      break;
    case "setOverride": {
      const membership = requireMembership(after, mutation.agentId);
      if (!connectionIds.has(mutation.connectionId)) throw failure("invalid");

      const overrides = { ...membership.overrides };
      if (mutation.allowed === null) delete overrides[mutation.connectionId];
      else overrides[mutation.connectionId] = mutation.allowed;
      after.memberships.set(mutation.agentId, { ...membership, overrides });
      break;
    }
    case "resetOverrides":
      after.memberships.set(mutation.agentId, {
        ...requireMembership(after, mutation.agentId),
        overrides: DEFAULT_MCP_MEMBERSHIP.overrides,
      });
      break;
  }
  return after;
}

function describeChanges(
  before: PolicyState,
  after: PolicyState,
): { preview: AgentAccessPolicyPreview; affectedIds: string[] } {
  const changes: AgentAccessPolicyPreview["changes"][number][] = [];
  const affectedIds: string[] = [];

  for (const { id } of before.agents) {
    const from = requireMembership(before, id);
    const to = requireMembership(after, id);
    const oldPolicy = requirePolicy(before, from.policyId);
    const newPolicy = requirePolicy(after, to.policyId);
    if (from === to && oldPolicy === newPolicy) continue;

    const enabledConnectionIds: string[] = [];
    const disabledConnectionIds: string[] = [];
    let effectiveChanged = false;

    for (const connection of before.connections) {
      const oldChoice = resolveChoice(from, oldPolicy, connection);
      const newChoice = resolveChoice(to, newPolicy, connection);
      if (oldChoice.allowed === newChoice.allowed) continue;
      if (newChoice.allowed) enabledConnectionIds.push(connection.id);
      else disabledConnectionIds.push(connection.id);
      effectiveChanged ||= connection.available;
    }

    if (effectiveChanged) affectedIds.push(id);
    changes.push({
      agentId: id,
      enabledConnectionIds,
      disabledConnectionIds,
      overridesRemoved: Object.keys(from.overrides).filter((id) => !Object.hasOwn(to.overrides, id)).length,
      overridesRetained: Object.keys(to.overrides).filter((id) => Object.hasOwn(from.overrides, id)).length,
    });
  }

  return {
    preview: {
      revision: before.revision,
      changes,
      overridesRemoved: changes.reduce((total, change) => total + change.overridesRemoved, 0),
      overridesRetained: changes.reduce((total, change) => total + change.overridesRetained, 0),
    },
    affectedIds,
  };
}
