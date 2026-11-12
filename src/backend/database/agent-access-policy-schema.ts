export const AGENT_ACCESS_POLICY_SCHEMA_SQL = `
  CREATE TABLE agent_access_policies (
    policy_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    revision INTEGER NOT NULL CHECK (revision > 0),
    allow_new_connections INTEGER NOT NULL CHECK (allow_new_connections IN (0, 1)),
    choices_json TEXT NOT NULL CHECK (json_valid(choices_json))
  );

  CREATE TABLE agent_access_policy_memberships (
    agent_id TEXT NOT NULL PRIMARY KEY,
    policy_id TEXT REFERENCES agent_access_policies(policy_id) ON DELETE RESTRICT,
    overrides_json TEXT NOT NULL CHECK (json_valid(overrides_json))
  );

  CREATE TABLE agent_access_policy_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    connection_signature TEXT NOT NULL DEFAULT ''
  );

  INSERT INTO agent_access_policy_state (singleton, revision) VALUES (1, 0);

  CREATE TABLE agent_access_policy_refreshes (
    agent_id TEXT NOT NULL PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0)
  );
`;
