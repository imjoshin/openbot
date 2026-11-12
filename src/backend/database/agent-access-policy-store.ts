import type { DatabaseSync } from "node:sqlite";
import {
  type AgentAccessPolicy,
  type AgentAccessPolicyChoices,
  AgentAccessPolicyChoicesSchema,
  AgentAccessPolicySchema,
} from "@openbot/contracts/agent-access-policy";
import { Schema } from "effect";
import type { OpenBotDatabase } from "../openbot-database";
import { databaseRow, databaseRows, requiredNumberColumn, requiredStringColumn } from "./database-rows";

export interface AgentAccessPolicyMembership {
  readonly policyId: string | null;
  readonly overrides: AgentAccessPolicyChoices;
}

export const DEFAULT_MCP_MEMBERSHIP: AgentAccessPolicyMembership = { policyId: null, overrides: {} };

const readPolicy = Schema.decodeUnknownSync(AgentAccessPolicySchema);
const readChoices = Schema.decodeUnknownSync(AgentAccessPolicyChoicesSchema);

/** Owns policy, membership and pending refresh rows. Roster projection writes can replace agent JSON safely. */
export class AgentAccessPolicyStore {
  constructor(private readonly database: OpenBotDatabase) {}

  revision(): number {
    const row = databaseRow(this.database.connection.prepare("SELECT revision FROM agent_access_policy_state").get());
    if (!row) throw new Error("Missing agent access policy state.");
    return requiredNumberColumn(row, "revision");
  }

  policies(): Map<string, AgentAccessPolicy> {
    return new Map(
      databaseRows(
        this.database.connection.prepare("SELECT * FROM agent_access_policies ORDER BY name, policy_id").all(),
      )
        .map((row) => this.readPolicy(row))
        .map((policy) => [policy.id, policy]),
    );
  }

  policy(id: string): AgentAccessPolicy | null {
    const row = databaseRow(
      this.database.connection.prepare("SELECT * FROM agent_access_policies WHERE policy_id = ?").get(id),
    );
    return row ? this.readPolicy(row) : null;
  }

  membership(agentId: string): AgentAccessPolicyMembership {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT policy_id, overrides_json FROM agent_access_policy_memberships WHERE agent_id = ?")
        .get(agentId),
    );
    if (!row) return DEFAULT_MCP_MEMBERSHIP;
    return {
      policyId: row.policy_id === null ? null : requiredStringColumn(row, "policy_id"),
      overrides: readChoices(JSON.parse(requiredStringColumn(row, "overrides_json"))),
    };
  }

  saveMembership(agentId: string, membership: AgentAccessPolicyMembership): void {
    const db = this.database.connection;
    if (membership.policyId === null && Object.keys(membership.overrides).length === 0) {
      db.prepare("DELETE FROM agent_access_policy_memberships WHERE agent_id = ?").run(agentId);
      return;
    }

    db.prepare(
      `INSERT INTO agent_access_policy_memberships (agent_id, policy_id, overrides_json) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET policy_id = excluded.policy_id, overrides_json = excluded.overrides_json`,
    ).run(agentId, membership.policyId, JSON.stringify(membership.overrides));
  }

  savePolicy(policy: AgentAccessPolicy): void {
    this.database.connection
      .prepare(
        `INSERT INTO agent_access_policies (policy_id, name, revision, allow_new_connections, choices_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(policy_id) DO UPDATE SET name = excluded.name, revision = excluded.revision,
       allow_new_connections = excluded.allow_new_connections, choices_json = excluded.choices_json`,
      )
      .run(policy.id, policy.name, policy.revision, Number(policy.allowNewConnections), JSON.stringify(policy.choices));
  }

  deletePolicy(policyId: string): void {
    this.database.connection.prepare("DELETE FROM agent_access_policies WHERE policy_id = ?").run(policyId);
  }

  /** Called inside the same transaction that first publishes the saved connection. */
  registerConnection(connectionId: string): boolean {
    let registered = false;

    for (const policy of this.policies().values()) {
      if (!Object.hasOwn(policy.choices, connectionId)) {
        this.savePolicy({
          ...policy,
          revision: policy.revision + 1,
          choices: { ...policy.choices, [connectionId]: policy.allowNewConnections },
        });
        registered = true;
      }
    }
    return registered;
  }

  pendingRefresh(agentId: string): number | null {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT revision FROM agent_access_policy_refreshes WHERE agent_id = ?")
        .get(agentId),
    );
    return row ? requiredNumberColumn(row, "revision") : null;
  }

  markRefresh(agentId: string, revision: number): void {
    this.database.connection
      .prepare(
        `INSERT INTO agent_access_policy_refreshes (agent_id, revision) VALUES (?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET revision = excluded.revision`,
      )
      .run(agentId, revision);
  }

  finishRefresh(agentId: string, revision: number): void {
    this.database.connection
      .prepare("DELETE FROM agent_access_policy_refreshes WHERE agent_id = ? AND revision = ?")
      .run(agentId, revision);
  }

  advanceRevision(): number {
    advanceAgentAccessPolicyRevision(this.database.connection);
    return this.revision();
  }

  observeConnections(signature: string): void {
    this.database.connection
      .prepare(
        `UPDATE agent_access_policy_state SET connection_signature = ?, revision = revision + 1
       WHERE singleton = 1 AND connection_signature != ?`,
      )
      .run(signature, signature);
  }

  transaction<A>(run: () => A): A {
    const db = this.database.connection;
    if (db.isTransaction) return run();

    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  private readPolicy(row: ReturnType<typeof databaseRows>[number]): AgentAccessPolicy {
    return readPolicy({
      id: requiredStringColumn(row, "policy_id"),
      name: requiredStringColumn(row, "name"),
      revision: requiredNumberColumn(row, "revision"),
      allowNewConnections: requiredNumberColumn(row, "allow_new_connections") === 1,
      choices: JSON.parse(requiredStringColumn(row, "choices_json")),
    });
  }
}

export function advanceAgentAccessPolicyRevision(db: DatabaseSync): void {
  db.exec("UPDATE agent_access_policy_state SET revision = revision + 1");
}
