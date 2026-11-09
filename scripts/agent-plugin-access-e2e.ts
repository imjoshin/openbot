// Checks local plugin settings against the real service and database on a temporary profile.
// Run: bun scripts/agent-plugin-access-e2e.ts. No external accounts are used.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeAgentPluginsFromMain, normalizeMcpConfig, parseSetAgentPluginInput } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { agentMcpServers } from "../src/backend/mcp-provider-shapes";
import { McpServerStore } from "../src/backend/mcp-server-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-plugin-access-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; unverified: string[]; steps: Step[] } = {
  passed: false,
  unverified: ["External providers may also load connections configured outside OpenBot."],
  steps: [],
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

const root = await mkdtemp(join(tmpdir(), "openbot-agent-plugin-access-"));
const userData = join(root, "user-data");
const home = join(root, "home");

const database = new OpenBotDatabase(userData);
const agentStore = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
await runCauseEffect(sidebar.initialize());
await runCauseEffect(agentStore.initialize());
await runCauseEffect(mailbox.initialize());
const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });

try {
  const first = await runCauseEffect(
    agentStore.createAgent({ name: "First", description: "", avatarSeed: "first", avatarHue: null }),
  );
  const second = await runCauseEffect(
    agentStore.createAgent({ name: "Second", description: "", avatarSeed: "second", avatarHue: null }),
  );
  const mcp = new McpServerStore(database);
  const alpha = mcp.save(
    normalizeMcpConfig({
      id: "",
      enabled: true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      name: "Alpha",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: [{ key: "Authorization", value: "test-secret" }],
    }),
  );
  const beta = mcp.save(
    normalizeMcpConfig({
      id: "",
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      headers: [],
      name: "Beta",
      transport: "http",
      url: "http://127.0.0.1:2/mcp",
      enabled: false,
    }),
  );
  await step("new agents allow every plugin without exposing credentials", async () => {
    const rows = decodeAgentPluginsFromMain(agents.listAgentPlugins(first.id));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.enabled));
    assert.equal(rows.find((row) => row.id === beta.id)?.available, false);
    assert.ok(!JSON.stringify(rows).includes("test-secret"));
    assert.ok(!JSON.stringify(rows).includes("127.0.0.1"));
  });
  await step("a failed first save rolls back memory and disk", async () => {
    database.connection.exec(
      "CREATE TEMP TRIGGER reject_plugin_update BEFORE INSERT ON projection_agents BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
    );
    try {
      await assert.rejects(
        runCauseEffect(agents.setAgentPlugin({ agentId: first.id, pluginId: alpha.id, enabled: false })),
      );
      assert.equal(agentStore.list().find((agent) => agent.id === first.id)?.disabledMcpServerIds, undefined);
    } finally {
      database.connection.exec("DROP TRIGGER reject_plugin_update");
    }
    await runCauseEffect(agentStore.updateAgent({ agentId: first.id, title: "After failed write" }));
    const loaded = new AgentStore(userData, home, database);
    await runCauseEffect(loaded.initialize());
    assert.equal(loaded.list().find((agent) => agent.id === first.id)?.disabledMcpServerIds, undefined);
  });
  await step("disable one plugin and keep the other agent unchanged", async () => {
    const rows = await runCauseEffect(agents.setAgentPlugin({ agentId: first.id, pluginId: alpha.id, enabled: false }));
    assert.equal(rows.find((row) => row.id === alpha.id)?.enabled, false);
    assert.ok(agents.listAgentPlugins(second.id).every((row) => row.enabled));
    const saved = agentStore.list().find((agent) => agent.id === first.id);
    assert.deepEqual(saved?.disabledMcpServerIds, [alpha.id]);
    assert.deepEqual(
      agentMcpServers(mcp.list(), true, saved?.disabledMcpServerIds).map((row) => row.id),
      [beta.id],
    );
  });
  await step("refuse changes while a persisted turn is active", async () => {
    const threadId = agentStore.ensureThreadIdNow(first.id);
    const busy = (activeTurnId: string | null) =>
      database.persistConversationChanges({
        agentId: first.id,
        threadId,
        activeTurnId,
        changedMessages: [],
        removedMessageIds: [],
        eventType: "test.plugin-busy",
      });
    busy("busy-turn");
    try {
      await assert.rejects(
        runCauseEffect(agents.setAgentPlugin({ agentId: first.id, pluginId: alpha.id, enabled: true })),
        /Stop this agent/,
      );
      assert.equal(agents.listAgentPlugins(first.id).find((row) => row.id === alpha.id)?.enabled, false);
    } finally {
      busy(null);
    }
  });
  await step("reject malformed input and unknown connections", async () => {
    assert.throws(() => parseSetAgentPluginInput({ agentId: first.id, pluginId: alpha.id, enabled: "false" }));
    await assert.rejects(
      runCauseEffect(agents.setAgentPlugin({ agentId: first.id, pluginId: "missing", enabled: false })),
    );
    await assert.rejects(runCauseEffect(agentStore.updateAgent({ agentId: first.id, disabledMcpServerIds: [""] })));
  });
  await step("keep restrictions after an unrelated edit, duplicate, and store reload", async () => {
    await runCauseEffect(agentStore.updateAgent({ agentId: first.id, title: "Updated" }));
    const duplicate = await runCauseEffect(agentStore.duplicateAgent(first.id));
    assert.deepEqual(duplicate.disabledMcpServerIds, [alpha.id]);
    const reloaded = new AgentStore(userData, home, database);
    await runCauseEffect(reloaded.initialize());
    assert.deepEqual(reloaded.list().find((agent) => agent.id === first.id)?.disabledMcpServerIds, [alpha.id]);
  });
  await step("new connections default on and re-enabling removes the restriction", async () => {
    const gamma = mcp.save(
      normalizeMcpConfig({
        id: "",
        enabled: true,
        command: "",
        args: [],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        headers: [],
        name: "Gamma",
        transport: "http",
        url: "http://127.0.0.1:3/mcp",
      }),
    );
    assert.equal(agents.listAgentPlugins(first.id).find((row) => row.id === gamma.id)?.enabled, true);
    const rows = await runCauseEffect(agents.setAgentPlugin({ agentId: first.id, pluginId: alpha.id, enabled: true }));
    assert.ok(rows.every((row) => row.enabled));
  });
  report.passed = true;
} finally {
  await runCauseEffect(agents.stop()).catch(() => undefined);
  database.close();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
