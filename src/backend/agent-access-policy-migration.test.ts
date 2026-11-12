// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const databases: DatabaseSync[] = [];
const sources = Array.from({ length: 53 }, (_, index) => index + 8);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  return database;
}

function migrateUpTo(database: DatabaseSync, version: number): void {
  database.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(database)).toThrow(`migration to version ${version + 1} failed`);
  database.exec("DROP TRIGGER stop_at_version");
}

function sourceDatabase(version: number, database = open()): DatabaseSync {
  database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(database, version);
  database.exec(`
    INSERT INTO projection_threads
      (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('openbot-thread-fixture', 'fixture', 'Fixture', NULL, '2026-09-01', '2026-09-01', 1);
    INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('fixture', 'openbot-thread-fixture', 'gpt-6-luna', '2026-09-01', 0,
      '{"id":"fixture","name":"Fixture","workspacePath":"C:/Agents/Fixture","unrelated":{"keep":"value"}}', 1);
    INSERT INTO projection_provider_sessions
      (id, thread_id, provider, external_session_id, model, effort, state, created_at, updated_at, last_event_sequence)
    VALUES ('session-1', 'openbot-thread-fixture', 'codex', 'external-1', 'gpt-6-luna', 'low', 'inactive',
      '2026-09-01', '2026-09-01', 1);
  `);
  return database;
}

function oldContents(database: DatabaseSync) {
  const tables = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    AND name <> 'schema_migrations' AND name NOT GLOB 'agent_access_polic*' ORDER BY name`)
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${name}"`).all()]),
  );
}

function policyTables(database: DatabaseSync) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'agent_access_polic*'")
    .all();
}

function expectHealthy(database: DatabaseSync): void {
  expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 61 });
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("agent access policy migration", () => {
  it.each(sources)("preserves data from schema %i and starts with no assignments", (source) => {
    const database = sourceDatabase(source);
    if (source < 60) migrateUpTo(database, 60);
    const before = oldContents(database);
    migrateOpenBotDatabase(database);
    expect(oldContents(database)).toEqual(before);
    expect(database.prepare("SELECT * FROM agent_access_policies").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM agent_access_policy_memberships").all()).toEqual([]);
    expect(database.prepare("SELECT revision FROM agent_access_policy_state").get()).toEqual({ revision: 0 });
    expectHealthy(database);
  });

  it("rolls back a failed marker write and preserves every existing row after reopen and retry", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-policy-migration-"));
    const path = join(root, "openbot.db");
    let database = new DatabaseSync(path);
    try {
      sourceDatabase(60, database);
      const before = oldContents(database);
      database.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 61
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
      expect(() => migrateOpenBotDatabase(database)).toThrow("migration to version 61 failed");
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      database.close();
      database = new DatabaseSync(path);
      expect(policyTables(database)).toEqual([]);
      expect(oldContents(database)).toEqual(before);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 60 });
      migrateOpenBotDatabase(database);
      database.close();
      database = new DatabaseSync(path);
      expect(oldContents(database)).toEqual(before);
      expectHealthy(database);
    } finally {
      if (database.isOpen) database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a downgrade and a missing migration marker before creating tables", () => {
    const database = sourceDatabase(60);
    const before = oldContents(database);
    database.exec("INSERT INTO schema_migrations VALUES (62, '2026-09-01')");
    expect(() => migrateOpenBotDatabase(database)).toThrow("newer than this application supports");
    database.exec("DELETE FROM schema_migrations WHERE version IN (59, 62)");
    expect(() => migrateOpenBotDatabase(database)).toThrow("missing version 59");
    expect(policyTables(database)).toEqual([]);
    expect(oldContents(database)).toEqual(before);
  });

  it("requires a valid group reference in upgraded and fresh databases", () => {
    for (const database of [sourceDatabase(60), open()]) {
      migrateOpenBotDatabase(database);
      expect(() =>
        database.exec(`INSERT INTO agent_access_policy_memberships VALUES ('fixture', 'gone', '{}')`),
      ).toThrow("FOREIGN KEY constraint failed");
      expectHealthy(database);
    }
  });
});
