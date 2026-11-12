import type {
  AgentAccessPolicy,
  AgentAccessPolicyAgent,
  AgentAccessPolicyConnection,
  AgentAccessPolicyMutation,
  AgentAccessPolicyPreview,
  AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import type { ClientAgentSummary } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { AgentAccessPolicyCalls } from "@openbot/ui/features/servers/AgentGroups";

type Access = Pick<AgentAccessPolicyAgent, "policyId" | "overrides">;

function resolve(
  agent: Access,
  policies: readonly AgentAccessPolicy[],
  connections: readonly AgentAccessPolicyConnection[],
) {
  const policy = policies.find((item) => item.id === agent.policyId);
  if (agent.policyId !== null && !policy) throw new Error(sourceText("error.agent.accessPolicy.invalid"));

  return connections.map((connection) => {
    const groupValue = policy ? (policy.choices[connection.id] ?? false) : null;
    const override = agent.overrides[connection.id] ?? null;
    const source = override !== null ? "override" : policy ? "policy" : "default";
    return {
      connectionId: connection.id,
      source,
      groupValue,
      override,
      allowed: override ?? groupValue ?? true,
      available: connection.available,
    } as const;
  });
}

export function createMockAgentAccessPolicy(
  serverId: string,
  listAgents: () => readonly Pick<ClientAgentSummary, "id" | "name">[],
  listConnections: () => readonly AgentAccessPolicyConnection[],
  initial: Pick<AgentAccessPolicySnapshot, "policies" | "agents"> = { policies: [], agents: [] },
): AgentAccessPolicyCalls & {
  assignCreated: (agentId: string, policyId: string | null, expectedRevision: number) => void;
  copyAgentAccess: (sourceId: string, agentId: string) => void;
} {
  let revision = 0;
  let connectionSignature: string | undefined;
  let policies = [...initial.policies];
  let assignments = new Map<string, Access>(
    initial.agents.map(({ id, policyId, overrides }) => [id, { policyId, overrides }]),
  );

  function observeConnections() {
    const connections = listConnections();
    const signature = JSON.stringify(connections.map(({ id, available }) => [id, available]).sort());

    if (signature !== connectionSignature) {
      connectionSignature = signature;
      revision += 1;
      policies = policies.map((policy) => {
        const registered = connections.filter(({ id }) => !Object.hasOwn(policy.choices, id));
        if (registered.length === 0) return policy;

        return {
          ...policy,
          revision: policy.revision + 1,
          choices: {
            ...policy.choices,
            ...Object.fromEntries(registered.map(({ id }) => [id, policy.allowNewConnections])),
          },
        };
      });
    }

    return connections;
  }

  function snapshot(
    groups: readonly AgentAccessPolicy[],
    access: ReadonlyMap<string, Access>,
    nextRevision: number,
    connections: readonly AgentAccessPolicyConnection[],
  ): AgentAccessPolicySnapshot {
    const agents = listAgents().map(({ id, name }) => {
      const current = access.get(id) ?? { policyId: null, overrides: {} };
      return { id, name, ...current, connections: resolve(current, groups, connections) };
    });
    return { revision: nextRevision, policies: groups, agents, connections };
  }

  function checkRevision(expected: number) {
    if (expected !== revision) throw new Error(sourceText("error.agent.accessPolicy.stale"));
  }

  function change(input: AgentAccessPolicyMutation) {
    const connections = observeConnections();
    checkRevision(input.expectedRevision);

    const before = snapshot(policies, assignments, revision, connections);
    const nextAssignments = new Map(assignments);
    let nextPolicies = [...policies];

    function assign(agentId: string, policyId: string | null, keep: boolean) {
      const agent = before.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error(sourceText("error.agent.accessPolicy.invalid"));

      const overrides =
        policyId === null
          ? Object.fromEntries(agent.connections.filter((row) => !row.allowed).map((row) => [row.connectionId, false]))
          : keep
            ? agent.overrides
            : {};
      nextAssignments.set(agentId, { policyId, overrides });
    }

    switch (input.kind) {
      case "savePolicy": {
        const id = input.policyId ?? crypto.randomUUID();
        const saved = policies.find((policy) => policy.id === id);
        if (input.policyId !== null && !saved) throw new Error(sourceText("error.agent.accessPolicy.invalid"));

        const policy = {
          id,
          name: input.name,
          allowNewConnections: input.allowNewConnections,
          revision: revision + 1,
          choices: {
            ...Object.fromEntries(connections.map(({ id }) => [id, false])),
            ...saved?.choices,
            ...input.choices,
          },
        };

        nextPolicies = saved ? nextPolicies.map((item) => (item.id === id ? policy : item)) : [...nextPolicies, policy];
        for (const assignment of input.assignments)
          assign(assignment.agentId, assignment.assigned ? id : null, assignment.keepOverrides);
        break;
      }
      case "deletePolicy":
        if (
          input.destinationPolicyId === input.policyId ||
          !policies.some((policy) => policy.id === input.policyId) ||
          (input.destinationPolicyId !== null && !policies.some((policy) => policy.id === input.destinationPolicyId))
        )
          throw new Error(sourceText("error.agent.accessPolicy.invalid"));

        nextPolicies = nextPolicies.filter((policy) => policy.id !== input.policyId);
        for (const agent of before.agents) {
          if (agent.policyId === input.policyId) assign(agent.id, input.destinationPolicyId, false);
        }
        break;
      case "assignAgent":
        assign(input.agentId, input.policyId, input.keepOverrides);
        break;
      case "setOverride":
      case "resetOverrides": {
        const agent = before.agents.find((agent) => agent.id === input.agentId);
        if (!agent) throw new Error(sourceText("error.agent.accessPolicy.invalid"));

        const overrides = input.kind === "resetOverrides" ? {} : { ...agent.overrides };
        if (input.kind === "setOverride") {
          if (input.allowed === null) delete overrides[input.connectionId];
          else overrides[input.connectionId] = input.allowed;
        }

        nextAssignments.set(agent.id, { policyId: agent.policyId, overrides });
        break;
      }
    }

    const after = snapshot(nextPolicies, nextAssignments, revision + 1, connections);
    return { before, after, nextPolicies, nextAssignments };
  }

  async function preview(input: AgentAccessPolicyMutation): Promise<AgentAccessPolicyPreview> {
    const { before, after } = change(input);
    const changes = after.agents.flatMap((agent, index) => {
      const previous = before.agents[index];
      if (!previous) return [];

      const changed = agent.connections.filter(
        (row) => previous.connections.find((item) => item.connectionId === row.connectionId)?.allowed !== row.allowed,
      );
      const overridesRemoved = Object.keys(previous.overrides).filter((id) => agent.overrides[id] === undefined).length;
      const overridesRetained = Object.keys(agent.overrides).length;
      const affectedGroup =
        (input.kind === "savePolicy" || input.kind === "deletePolicy") &&
        input.policyId !== null &&
        input.policyId === previous.policyId;

      if (
        !affectedGroup &&
        !changed.length &&
        !overridesRemoved &&
        agent.policyId === previous.policyId &&
        !("agentId" in input && input.agentId === agent.id)
      )
        return [];

      return [
        {
          agentId: agent.id,
          enabledConnectionIds: changed.filter((row) => row.allowed).map((row) => row.connectionId),
          disabledConnectionIds: changed.filter((row) => !row.allowed).map((row) => row.connectionId),
          overridesRemoved,
          overridesRetained,
        },
      ];
    });

    return {
      revision,
      changes,
      overridesRemoved: changes.reduce((total, change) => total + change.overridesRemoved, 0),
      overridesRetained: changes.reduce((total, change) => total + change.overridesRetained, 0),
    };
  }

  return {
    serverId,
    list: async () => {
      const connections = observeConnections();
      return structuredClone(snapshot(policies, assignments, revision, connections));
    },
    preview,
    apply: async (input) => {
      const next = change(input);
      policies = next.nextPolicies;
      assignments = next.nextAssignments;
      revision += 1;
      return { status: "saved", snapshot: structuredClone(next.after), agentIds: [] };
    },
    assignCreated(agentId, policyId, expectedRevision) {
      observeConnections();
      checkRevision(expectedRevision);
      if (policyId !== null && !policies.some((policy) => policy.id === policyId)) {
        throw new Error(sourceText("error.agent.accessPolicy.invalid"));
      }

      assignments.set(agentId, { policyId, overrides: {} });
      revision += 1;
    },
    copyAgentAccess(sourceId, agentId) {
      const source = assignments.get(sourceId);
      if (!source) return;

      assignments.set(agentId, { policyId: source.policyId, overrides: { ...source.overrides } });
      revision += 1;
    },
  };
}
