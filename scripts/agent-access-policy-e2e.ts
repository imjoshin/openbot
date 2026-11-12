// Run with `bun scripts/agent-access-policy-e2e.ts`.
// Uses the real agent service and SQLite profile with a local provider process and MCP server.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentAccessPolicyActor,
  AgentAccessPolicyMutation,
  AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import {
  AGENT_PROVIDERS,
  type AgentSummary,
  agentComputerUseEnabled,
  COMPUTER_USE_MCP_SERVER_ID,
  type McpServerConfig,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { McpOAuthRecord } from "../src/backend/mcp-oauth-provider";
import type { McpOAuthProxySettings } from "../src/backend/mcp-oauth-proxy";

const out = resolve(import.meta.dirname, "../.openbot-build/agent-groups/host-validation");
const root = await mkdtemp(join(tmpdir(), "openbot-agent-groups-"));
const home = join(root, "home");
const userData = join(root, "user-data");
const fixture = join(import.meta.dirname, "agent-access-policy-fixture.cjs");
const launcher = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
const logPath = join(root, "codex.jsonl");
const owner: AgentAccessPolicyActor = { userId: "local", role: "owner" };
const unused = () => Effect.die(new Error("Unexpected browser operation."));
const browser: AgentBrowserHost = {
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

await mkdir(home);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(
  launcher,
  process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixture}" "${root}" %*\r\n`
    : `#!/bin/sh\nexec ${[process.execPath, fixture, root].map(shellQuote).join(" ")} "$@"\n`,
  { mode: 0o755 },
);
process.env.OPENBOT_CODEX_PATH = launcher;
process.env.CODEX_HOME = join(home, ".codex");

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { SidebarLayoutStore } = await import("../src/backend/sidebar-layout-store");
const { McpOAuth, mcpOAuthAccountKey } = await import("../src/backend/mcp-oauth-provider");
const { NO_PROVIDER_CREDENTIALS } = await import("../src/backend/provider-drivers");

const requests: string[] = [];
const requestAccounts: string[] = [];
const http = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });

  request.on("end", () => {
    const { id, method }: { id?: number; method: string } = JSON.parse(body);
    requests.push(method);
    const authorization = request.headers.authorization;
    requestAccounts.push(
      authorization === "Bearer fixture-work"
        ? "work"
        : authorization === "Bearer fixture-personal"
          ? "personal"
          : "none",
    );

    if (id === undefined) {
      response.writeHead(202).end();
      return;
    }

    const results: DynamicRecord = {
      initialize: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "Policy fixture", version: "1" },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
      "tools/list": { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      "tools/call": { content: [{ type: "text", text: "echo from fixture" }] },
      "resources/list": { resources: [{ uri: "fixture://note", name: "Note" }] },
      "resources/read": { contents: [{ uri: "fixture://note", text: "Fixture note" }] },
      "prompts/list": { prompts: [{ name: "fixture" }] },
      "prompts/get": { messages: [{ role: "user", content: { type: "text", text: "Fixture prompt" } }] },
    };

    response.writeHead(200, { "content-type": "application/json" });
    const result = results[method];
    response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(result ? { result } : { error: { code: -32601 } }) }));
  });
});

await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
const address = http.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

const records = new Map<string, McpOAuthRecord>();
let proxySettings: McpOAuthProxySettings | null = null;
const oauth = new McpOAuth({
  storage: {
    read: (key) => records.get(key) ?? null,
    write: (key, record) =>
      Effect.sync(() => {
        records.set(key, record);
      }),
    clear: (key) =>
      Effect.sync(() => {
        records.delete(key);
      }),
  },
  openExternal: async () => {
    throw new Error("Unexpected browser sign-in.");
  },
  redirectUrl: "http://127.0.0.1:1455/mcp-auth",
  logger: createOpenBotLogger("mcp-oauth", () => undefined),
});

let database: InstanceType<typeof OpenBotDatabase>;
let store: InstanceType<typeof AgentStore>;
let mailbox: InstanceType<typeof MailboxStore>;
let agents: InstanceType<typeof AgentService>;
let marketplaceConnectionId: string | undefined;
const sidebar = new SidebarLayoutStore(join(userData, "sidebar.json"));
let started = false;

async function start() {
  database = new OpenBotDatabase(userData);
  store = new AgentStore(userData, home, database);
  mailbox = new MailboxStore(userData, store.sharedRoot, database);
  agents = new AgentService({
    store,
    mailbox,
    browser,
    sidebarLayout: sidebar,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    requestTimeoutMs: 8_000,
    timezone: () => "UTC",
    marketplaceAppServer: (appId) => {
      if (appId !== "linear") return null;
      const config = agents.listMcpServers().find(({ id }) => id === marketplaceConnectionId);
      return config ? { config, setupSteps: [] } : null;
    },
    credentials: {
      ...NO_PROVIDER_CREDENTIALS,
      mcpOAuth: oauth,
      mcpOAuthProxySettings: {
        read: () => proxySettings,
        write: (next) =>
          Effect.sync(() => {
            proxySettings = next;
          }),
      },
    },
  });

  started = true;
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(agents.initialize());
}

async function stop() {
  if (!started) return;
  started = false;
  try {
    await runCauseEffect(agents.stop());
  } finally {
    database.close();
  }
}

type Mutation = AgentAccessPolicyMutation extends infer M
  ? M extends { expectedRevision: number }
    ? Omit<M, "expectedRevision">
    : never
  : never;
const read = () => Effect.runPromise(agents.agentAccessPolicy.read(owner));
const revision = async (mutation: Mutation): Promise<AgentAccessPolicyMutation> => ({
  ...mutation,
  expectedRevision: (await read()).revision,
});
const apply = (mutation: AgentAccessPolicyMutation) =>
  Effect.runPromise(agents.agentAccessPolicy.apply(mutation, owner));
const preview = (mutation: AgentAccessPolicyMutation) =>
  Effect.runPromise(agents.agentAccessPolicy.preview(mutation, owner));

async function save(mutation: Mutation): Promise<AgentAccessPolicySnapshot> {
  const result = await apply(await revision(mutation));
  assert.equal(result.status, "saved");
  return result.snapshot;
}

async function refused(mutation: AgentAccessPolicyMutation, code: string, agentId?: string) {
  const result = await Effect.runPromise(Effect.result(agents.agentAccessPolicy.apply(mutation, owner)));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.code, code);
  if (agentId) assert.deepEqual(result.failure.agentIds, [agentId]);
}

function member(snapshot: AgentAccessPolicySnapshot, agentId: string) {
  const entry = snapshot.agents.find(({ id }) => id === agentId);
  assert.ok(entry, "Missing agent in policy snapshot.");
  return entry;
}

function choice(snapshot: AgentAccessPolicySnapshot, agentId: string, connectionId: string) {
  const entry = member(snapshot, agentId).connections.find((row) => row.connectionId === connectionId);
  assert.ok(entry, "Missing connection in policy snapshot.");
  return entry;
}

const group = (
  name: string,
  choices: Record<string, boolean> = {},
  policyId: string | null = null,
  allowNewConnections = false,
): Mutation => ({
  kind: "savePolicy",
  policyId,
  name,
  allowNewConnections,
  choices,
  assignments: [],
});
const assign = (agentId: string, policyId: string | null, keepOverrides = false): Mutation => ({
  kind: "assignAgent",
  agentId,
  policyId,
  keepOverrides,
});
const override = (agentId: string, connectionId: string, allowed: boolean | null): Mutation => ({
  kind: "setOverride",
  agentId,
  connectionId,
  allowed,
});

async function connection(name: string, id = "", account?: string) {
  const resource = account ? `${url}#account-${account}` : url;
  const key = mcpOAuthAccountKey(resource);

  if (account && key && !records.has(key)) {
    records.set(key, { tokens: { access_token: `fixture-${account}`, token_type: "Bearer" } });
  }

  const config: McpServerConfig = {
    id,
    name,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: resource,
    headers: [],
  };
  const rows = await runCauseEffect(agents.saveMcpServer({ config }));
  const row = rows.find((entry) => entry.name === name);
  assert.ok(row);
  return row.id;
}

interface ProviderLog {
  kind: string;
  threadId: string;
  name?: string;
  result?: { success: boolean; contentItems?: { text?: string }[] };
}

function providerLog(): ProviderLog[] {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor<T>(label: string, readState: () => T | null | false | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = readState();
    if (state) return state;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 15));
  }
}

async function done(deliveryId: string) {
  const delivery = await waitFor("the delivery result", () => {
    const item = mailbox.getDelivery(deliveryId)?.delivery;
    return item && ["completed", "failed", "interrupted"].includes(item.status) ? item : null;
  });
  assert.equal(delivery.status, "completed", delivery.error ?? delivery.status);
  await waitFor(
    "the agent to settle",
    () => !agents.workingAgents().some(({ id }) => id === delivery.recipientAgentId),
  );
}

async function createAgent(name: string, policyId: string, computerUse: boolean) {
  const agent = await runCauseEffect(
    agents.createAgent(
      {
        name,
        description: "Policy fixture agent",
        avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
        avatarHue: null,
        initialMessage: "Hello",
        provider: "codex",
      },
      ({ id }) => agents.updateAgent({ agentId: id, computerUse }),
      undefined,
      undefined,
      false,
      { actor: owner, expectedRevision: (await read()).revision, policyId },
    ),
  );
  await firstTurn(agent.id);
  return agent;
}

async function firstTurn(agentId: string) {
  const delivery = await waitFor("the first delivery", () => agents.listQueue(agentId).deliveries[0]);
  await done(delivery.id);
}

async function send(agentId: string, text: string) {
  const receipt = await runCauseEffect(agents.sendMessage({ agentId, text }));
  const delivery = receipt.deliveries[0];
  assert.ok(delivery);
  return delivery.id;
}

async function tool(agentId: string, name: string, args: DynamicRecord) {
  const before = providerLog().length;
  await done(
    await send(agentId, `POLICY-CALL:${Buffer.from(JSON.stringify({ name, arguments: args })).toString("base64")}`),
  );
  const entry = providerLog()
    .slice(before)
    .find((row) => row.kind === "tool" && row.name === name);
  assert.ok(entry?.result, `No result for ${name}.`);
  return entry.result;
}

function privateSession(agent: AgentSummary) {
  assert.ok(agent.threadId);
  return database.activeProviderSession(agent.threadId, "codex")?.externalSessionId ?? null;
}

interface HandoffServer {
  enabled?: boolean;
  url?: string;
  http_headers?: Record<string, string>;
}

interface CodexFixtureServer extends HandoffServer {
  command?: string;
  tools?: Record<string, { approval_mode: "approve" }>;
}

const codexConfig = join(root, "codex-config.json");
const readCodexConfig = (): Record<string, CodexFixtureServer> => JSON.parse(readFileSync(codexConfig, "utf8"));

function handoff(agent: AgentSummary): Record<string, HandoffServer> {
  const session = privateSession(agent);
  assert.ok(session, "The provider has no active session.");
  return JSON.parse(readFileSync(join(root, `handoff-${session}.json`), "utf8"));
}

function handedServers(agent: AgentSummary) {
  return Object.entries(handoff(agent))
    .filter(([, server]) => server.enabled)
    .map(([name]) => name)
    .sort();
}

async function mcpCall(route: HandoffServer, method: string, params: DynamicRecord = {}, headers = route.http_headers) {
  assert.ok(route.url);
  const response = await fetch(route.url, {
    method: "POST",
    headers: { ...headers, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: await response.text() };
}

const report: { passed: boolean; cases: { name: string; passed: boolean; details?: object }[]; error?: string } = {
  passed: false,
  cases: [],
};

async function step(name: string, run: () => Promise<object>) {
  const item: (typeof report.cases)[number] = { name, passed: false };
  report.cases.push(item);
  item.details = await run();
  item.passed = true;
}

try {
  await start();
  const work = await connection("work_mail", "", "work");
  const personal = await connection("personal_mail", "", "personal");
  marketplaceConnectionId = personal;
  assert.notEqual(work, personal);

  const workGroup = (await save(group("Work", { [work]: true }))).policies[0];
  assert.ok(workGroup);
  const personalGroup = (await save(group("Personal", { [personal]: true }))).policies.find(
    ({ name }) => name === "Personal",
  );
  assert.ok(personalGroup);
  assert.equal(workGroup.choices[personal], false);
  assert.equal(personalGroup.choices[work], false);

  const workAgent = await createAgent("Work agent", workGroup.id, true);
  const personalAgent = await createAgent("Personal agent", personalGroup.id, false);
  const workspaceFile = join(personalAgent.workspacePath, "fixture-keep.txt");
  await writeFile(workspaceFile, "Personal workspace fixture.\n");
  const beforeSidebar = await runCauseEffect(
    sidebar.mutate(
      { type: "create", name: "Fixture section", agentId: personalAgent.id },
      new Set([workAgent.id, personalAgent.id]),
    ),
  );
  assert.ok(beforeSidebar.agentAssignments[personalAgent.id]);
  const initialWorkSession = privateSession(workAgent);
  const initialPersonalSession = privateSession(personalAgent);

  await step("Group assignment is saved before a human-created agent starts", async () => {
    assert.equal(member(await read(), workAgent.id).policyId, workGroup.id);
    assert.ok(handedServers(workAgent).includes("work_mail"));
    assert.ok(!handedServers(workAgent).includes("personal_mail"));
    assert.ok(handedServers(personalAgent).includes("personal_mail"));
    assert.ok(!handedServers(personalAgent).includes("work_mail"));
    return { work: handedServers(workAgent), personal: handedServers(personalAgent), sameEndpoint: true };
  });

  await step("Rename and future default preserve active private sessions across a restart", async () => {
    const originalRoute = handoff(workAgent).work_mail?.url;
    assert.ok(originalRoute);
    await save(group("Work renamed", {}, workGroup.id, true));
    assert.equal(privateSession(workAgent), initialWorkSession);
    assert.equal(privateSession(personalAgent), initialPersonalSession);

    const history = database.readConversation(workAgent.id, workAgent.threadId).messages;
    await stop();
    await start();
    assert.deepEqual(database.readConversation(workAgent.id, workAgent.threadId).messages, history);

    const before = providerLog().length;
    await done(await send(workAgent.id, "After restart"));
    assert.equal(privateSession(workAgent), initialWorkSession);
    assert.ok(
      providerLog()
        .slice(before)
        .some((row) => row.kind === "thread/resume" && row.threadId === initialWorkSession),
    );
    assert.equal(handoff(workAgent).work_mail?.url, originalRoute);
    return { historyMessages: history.length, resumed: true, proxyRoutePreserved: true };
  });

  await step("A revoked provider route denies tools, resources, and prompts without upstream traffic", async () => {
    await done(await send(personalAgent.id, "Load the Personal session"));
    const workRoute = handoff(workAgent).work_mail;
    const personalRoute = handoff(personalAgent).personal_mail;
    assert.ok(workRoute?.url && personalRoute?.url);
    assert.notEqual(workRoute.url, personalRoute.url);

    const methods = {
      initialize: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
      "tools/list": {},
      "tools/call": { name: "echo", arguments: {} },
      "resources/list": {},
      "resources/read": { uri: "fixture://note" },
      "prompts/list": {},
      "prompts/get": { name: "fixture" },
    };
    const before = requests.length;
    for (const [method, params] of Object.entries(methods)) {
      const response = await mcpCall(workRoute, method, params);
      assert.equal(response.status, 200);
      assert.match(response.body, /"result"/u);
    }
    assert.deepEqual(requests.slice(before), Object.keys(methods));
    assert.ok(requestAccounts.slice(before).every((account) => account === "work"));
    assert.equal((await mcpCall(personalRoute, "tools/list")).status, 200);
    assert.equal(requestAccounts.at(-1), "personal");
    assert.equal((await mcpCall(personalRoute, "tools/list", {}, workRoute.http_headers)).status, 403);

    await save(override(workAgent.id, work, false));
    const afterRevoke = requests.length;
    for (const [method, params] of Object.entries(methods)) {
      const response = await mcpCall(workRoute, method, params);
      assert.equal(response.status, 200);
      assert.match(response.body, /"code":-32001/u);
    }
    assert.equal(requests.length, afterRevoke);

    const deniedSearch = await tool(workAgent.id, "tool_search", { query: "work mail" });
    assert.equal(deniedSearch.success, true);
    assert.doesNotMatch(deniedSearch.contentItems?.[0]?.text ?? "", /"mcpTools"/u);
    await save(override(workAgent.id, work, null));
    const allowedSearch = await tool(workAgent.id, "tool_search", { query: "work mail" });
    assert.equal(allowedSearch.success, true);
    assert.match(allowedSearch.contentItems?.[0]?.text ?? "", /"mcpTools"/u);
    return {
      methods: Object.keys(methods),
      crossAgentStatus: 403,
      accountsIsolated: true,
      revokedUpstreamRequests: 0,
      discoveryScoped: true,
    };
  });

  await step("Override changes refresh only the affected agent and sync previews both directions", async () => {
    await save(override(workAgent.id, work, false));
    await save(override(workAgent.id, personal, true));
    assert.equal(privateSession(workAgent), null);
    assert.equal(privateSession(personalAgent), initialPersonalSession);
    await done(await send(workAgent.id, "After override"));
    assert.notEqual(privateSession(workAgent), initialWorkSession);
    assert.ok(handedServers(workAgent).includes("personal_mail"));
    assert.ok(!handedServers(workAgent).includes("work_mail"));

    const matching = await save(group("Work renamed", { [personal]: true }, workGroup.id));
    assert.equal(choice(matching, workAgent.id, personal).source, "override");
    assert.equal(choice(matching, workAgent.id, personal).groupValue, true);
    await save(group("Work renamed", { [personal]: false }, workGroup.id));

    const sync = await revision({ kind: "resetOverrides", agentId: workAgent.id });
    const planned = await preview(sync);
    assert.deepEqual(planned.changes, [
      {
        agentId: workAgent.id,
        enabledConnectionIds: [work],
        disabledConnectionIds: [personal],
        overridesRemoved: 2,
        overridesRetained: 0,
      },
    ]);
    assert.deepEqual(member((await apply(sync)).snapshot, workAgent.id).overrides, {});
    return { grants: 1, revocations: 1, removedOverrides: 2, otherSessionPreserved: true };
  });

  await step("A new group grant preserves the unaffected agent's private session on its next turn", async () => {
    const id = await connection("work_docs");
    assert.equal(agents.agentAccessPolicy.allows(workAgent.id, id), false);
    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, id), false);
    await done(await send(workAgent.id, "Before granting Work docs"));
    const beforeWork = privateSession(workAgent);
    const beforePersonal = privateSession(personalAgent);
    assert.ok(beforeWork && beforePersonal);

    await save(group("Work renamed", { [id]: true }, workGroup.id));
    await done(await send(workAgent.id, "After granting Work docs"));
    assert.notEqual(privateSession(workAgent), beforeWork);
    assert.ok(handedServers(workAgent).includes("work_docs"));
    await done(await send(personalAgent.id, "After another group gained access"));
    assert.equal(privateSession(personalAgent), beforePersonal);
    assert.ok(!handedServers(personalAgent).includes("work_docs"));
    await save(group("Work renamed", { [id]: false }, workGroup.id));
    return { affectedSessionReplaced: true, unaffectedNextTurnPreserved: true };
  });

  await step("MCP management sees only permitted connections", async () => {
    const listing = await tool(workAgent.id, "list_mcp_servers", {});
    assert.equal(listing.success, true);
    assert.match(JSON.stringify(listing), /work_mail/u);
    assert.doesNotMatch(JSON.stringify(listing), /personal_mail/u);

    const before = requests.length;
    const denied = await tool(workAgent.id, "test_mcp_server", { name: "personal_mail" });
    assert.equal(denied.success, false);
    assert.equal(
      (await tool(workAgent.id, "set_mcp_server_enabled", { name: "personal_mail", enabled: false })).success,
      false,
    );
    assert.equal((await tool(workAgent.id, "remove_mcp_server", { name: "personal_mail" })).success, false);
    const marketplace = await tool(workAgent.id, "suggest_marketplace_app", { app: "linear" });
    assert.equal(marketplace.success, false);
    assert.doesNotMatch(JSON.stringify(marketplace), /personal_mail/u);
    assert.equal(requests.length, before);
    const allowed = await tool(workAgent.id, "test_mcp_server", { name: "work_mail" });
    assert.equal(allowed.success, true);
    assert.ok(requests.slice(before).includes("tools/list"));

    const routine = agents.createRoutine({
      agentId: workAgent.id,
      name: "Policy routine",
      instruction: "Check the fixture connection.",
      active: false,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
      runIn: "thread",
    });
    const beforeRoutine = providerLog().length;
    const routineRun = await runCauseEffect(agents.testRoutine({ agentId: workAgent.id, routineId: routine.id }));
    assert.ok(routineRun.deliveryId);
    await done(routineRun.deliveryId);
    const sideThread = providerLog()
      .slice(beforeRoutine)
      .find(({ kind }) => kind === "thread/start");
    assert.ok(sideThread);
    const routineHandoff: Record<string, HandoffServer> = JSON.parse(
      readFileSync(join(root, `handoff-${sideThread.threadId}.json`), "utf8"),
    );
    assert.equal(routineHandoff.work_mail?.enabled, true);
    assert.notEqual(routineHandoff.personal_mail?.enabled, true);
    return {
      deniedUpstreamRequests: 0,
      allowedUpstreamMethods: requests.slice(before),
      routineRestricted: true,
      hiddenMarketplaceConnection: true,
    };
  });

  await step("Duplicate and agent-created child retain assignment and overrides", async () => {
    await save(override(workAgent.id, personal, false));
    const duplicate = await runCauseEffect(agents.duplicateAgent(workAgent.id));
    await runCauseEffect(agents.commitAgentDuplication(duplicate.id, sidebar.getSnapshot()));
    assert.equal(member(await read(), duplicate.id).policyId, workGroup.id);
    assert.deepEqual(member(await read(), duplicate.id).overrides, { [personal]: false });

    const childResult = await tool(workAgent.id, "create_agent", {
      name: "Policy child",
      description: "Fixture child",
      initialMessage: "Child first turn",
    });
    assert.equal(childResult.success, true, JSON.stringify(childResult));
    const child = agents.listAgents().find(({ name }) => name === "Policy child");
    assert.ok(child);
    await firstTurn(child.id);
    assert.equal(member(await read(), child.id).policyId, workGroup.id);
    assert.deepEqual(member(await read(), child.id).overrides, { [personal]: false });
    assert.ok(handedServers(child).includes("work_mail"));
    assert.ok(!handedServers(child).includes("personal_mail"));
    return { duplicate: true, childFirstTurn: handedServers(child) };
  });

  await step("Move with keep, move with clear, and remove preserve the specified choices", async () => {
    const keep = await revision(assign(workAgent.id, personalGroup.id, true));
    assert.equal((await preview(keep)).overridesRetained, 1);
    const staleOverride = await revision(override(workAgent.id, personal, true));
    await preview(staleOverride);
    assert.deepEqual(member((await apply(keep)).snapshot, workAgent.id).overrides, { [personal]: false });
    await refused(staleOverride, "stale");

    const clear = await revision(assign(workAgent.id, workGroup.id));
    assert.equal((await preview(clear)).overridesRemoved, 1);
    assert.deepEqual(member((await apply(clear)).snapshot, workAgent.id).overrides, {});

    const removed = member(await save(assign(workAgent.id, null)), workAgent.id);
    assert.equal(removed.policyId, null);
    assert.equal(removed.overrides[personal], false);
    assert.equal(removed.overrides[work], undefined);
    const future = await connection("future_mail");
    assert.equal(agents.agentAccessPolicy.allows(workAgent.id, future), true);
    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, future), false);
    return { retainedOnMove: 1, clearedOnMove: 1, removalPreservedDenial: true, assignmentInvalidatedPreview: true };
  });

  await step("Register new IDs before exposure and keep existing choices on reconnect", async () => {
    const disabled = await read();
    const beforeConnection = disabled.revision;
    await save(group("Personal", {}, personalGroup.id, true));
    const newId = await connection("new_mail");
    const registered = await read();
    assert.ok(registered.revision > beforeConnection);
    assert.equal(choice(registered, personalAgent.id, newId).allowed, true);
    assert.equal(choice(registered, personalAgent.id, work).allowed, false);
    assert.equal(await connection("work_mail_renamed", work, "work"), work);
    assert.equal(choice(await read(), personalAgent.id, work).allowed, false);

    const stale = await revision(override(personalAgent.id, personal, false));
    await preview(stale);
    await runCauseEffect(agents.setMcpServerEnabled({ mcpServerId: personal, enabled: false }));
    await refused(stale, "stale");
    const unavailable = choice(await save(override(personalAgent.id, personal, true)), personalAgent.id, personal);
    assert.equal(unavailable.allowed, true);
    assert.equal(unavailable.available, false);
    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, personal), false);
    await runCauseEffect(agents.setMcpServerEnabled({ mcpServerId: personal, enabled: true }));
    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, personal), true);

    const personalKey = mcpOAuthAccountKey(`${url}#account-personal`);
    assert.ok(personalKey);
    const personalRecord = records.get(personalKey);
    assert.ok(personalRecord?.tokens);
    await runCauseEffect(agents.signOutMcpServer({ mcpServerId: personal }));
    assert.equal(choice(await read(), personalAgent.id, personal).available, false);
    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, personal), false);
    records.set(personalKey, personalRecord);
    const reconnected = choice(await read(), personalAgent.id, personal);
    assert.equal(reconnected.available, true);
    assert.equal(reconnected.source, "override");
    assert.equal(reconnected.allowed, true);

    await runCauseEffect(agents.removeMcpServer({ mcpServerId: work }));
    const recreated = await connection("work_mail_renamed", "", "work");
    assert.notEqual(recreated, work);
    assert.equal(choice(await read(), personalAgent.id, recreated).allowed, true);
    return {
      registered: true,
      disabledEffectiveAccess: false,
      oldAndNewIdsDiffer: true,
      overridePreservedAfterSignIn: true,
    };
  });

  await step("A registration failure leaves no connection or partial choices", async () => {
    const before = await read();
    database.connection.exec(
      "CREATE TRIGGER fixture_reject_registration BEFORE UPDATE ON agent_access_policies BEGIN SELECT RAISE(ABORT, 'fixture registration failure'); END",
    );
    try {
      await assert.rejects(connection("failed_registration"), /fixture registration failure/u);
      assert.ok(!agents.listMcpServers().some(({ name }) => name === "failed_registration"));
      assert.deepEqual(await read(), before);
    } finally {
      database.connection.exec("DROP TRIGGER fixture_reject_registration");
    }

    const id = await connection("failed_registration");
    assert.equal(choice(await read(), personalAgent.id, id).allowed, true);
    return { rolledBack: true, successfulRetry: true };
  });

  await step("A failed SQLite save rolls back all policy changes", async () => {
    const before = await read();
    const change = await revision(group("Personal update", { [personal]: false }, personalGroup.id));
    database.connection.exec(
      "CREATE TRIGGER fixture_reject_revision BEFORE UPDATE OF revision ON agent_access_policy_state BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END",
    );
    try {
      await refused(change, "storage");
      assert.deepEqual(await read(), before);
    } finally {
      database.connection.exec("DROP TRIGGER fixture_reject_revision");
    }

    assert.equal((await apply(change)).status, "saved");
    return { rollback: true, sameRevisionRetry: true };
  });

  await step("Concurrent saves have one winner and unknown references fail closed", async () => {
    const expectedRevision = (await read()).revision;
    const outcomes = await Promise.all(
      [group("Concurrent A"), group("Concurrent B")].map((mutation) =>
        Effect.runPromise(Effect.result(agents.agentAccessPolicy.apply({ ...mutation, expectedRevision }, owner))),
      ),
    );
    assert.equal(outcomes.filter(Result.isSuccess).length, 1);
    const loser = outcomes.find(Result.isFailure);
    assert.equal(loser?.failure.code, "stale");
    await refused(await revision(assign(workAgent.id, "missing-policy")), "invalid");
    assert.equal(agents.agentAccessPolicy.allows("missing-agent", personal), false);

    const before = store.agentAccessPolicies.membership(personalAgent.id);
    database.connection.exec("PRAGMA foreign_keys = OFF");
    try {
      store.agentAccessPolicies.saveMembership(personalAgent.id, {
        policyId: "missing-policy",
        overrides: { [personal]: true },
      });
      assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, personal), false);
      assert.equal(
        agents.enabledMcpServers(personalAgent.id).some(({ id }) => id === personal),
        false,
      );
    } finally {
      store.agentAccessPolicies.saveMembership(personalAgent.id, before);
      database.connection.exec("PRAGMA foreign_keys = ON");
    }
    return { winners: 1, missingPolicyFallback: false };
  });

  await step("Starting, running, compacting, and subagent sessions reject affected access edits", async () => {
    const revoke = await revision(override(personalAgent.id, personal, false));

    for (const state of ["start", "active"]) {
      const before = providerLog().length;
      const delivery = await send(personalAgent.id, `HOLD-${state.toUpperCase()}`);
      await waitFor(state, () =>
        providerLog()
          .slice(before)
          .some(({ kind }) => kind === (state === "start" ? "starting" : "active")),
      );
      await refused(revoke, "busy", personalAgent.id);
      await writeFile(join(root, `release-${state}`), "");
      await done(delivery);
    }

    const compact = runCauseEffect(agents.compactAgentContext(personalAgent.id));
    await waitFor("compaction", () => providerLog().some(({ kind }) => kind === "compacting"));
    await refused(revoke, "busy", personalAgent.id);
    await writeFile(join(root, "release-compact"), "");
    await compact;

    const childDelivery = await send(personalAgent.id, "HOLD-SUBAGENT");
    await waitFor("running provider subagent", () =>
      database
        .readConversation(personalAgent.id, personalAgent.threadId)
        .messages.some((message) => message.subagents?.some((child) => child.status === "running")),
    );
    await refused(revoke, "busy", personalAgent.id);
    await writeFile(join(root, "release-subagent"), "");
    await done(childDelivery);
    return { refused: ["starting", "active", "compacting", "subagent"] };
  });

  await step("A saved policy with failed refresh blocks starts and recovers after a restart", async () => {
    const old = privateSession(personalAgent);
    assert.ok(old);
    const route = handoff(personalAgent).personal_mail;
    assert.ok(route?.url);
    await writeFile(join(root, "fail-refresh"), "");
    const changed = await apply(await revision(override(personalAgent.id, personal, false)));
    assert.equal(changed.status, "refreshPending");
    assert.deepEqual(changed.agentIds, [personalAgent.id]);
    assert.equal(choice(changed.snapshot, personalAgent.id, personal).allowed, false);
    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, personal), false);
    assert.notEqual(store.agentAccessPolicies.pendingRefresh(personalAgent.id), null);
    assert.equal(privateSession(personalAgent), old);

    const denied = await mcpCall(route, "tools/list");
    assert.match(denied.body, /"code":-32001/u);
    const before = providerLog().length;
    const delivery = await send(personalAgent.id, "Blocked by pending refresh");
    await waitFor(
      "a delivery blocked by pending refresh",
      () => mailbox.getDelivery(delivery)?.delivery.status === "failed",
    );
    assert.ok(
      providerLog()
        .slice(before)
        .some(({ kind }) => kind === "failed-refresh"),
    );
    assert.ok(
      !providerLog()
        .slice(before)
        .some(({ kind }) => kind === "turn/start"),
    );
    assert.notEqual(store.agentAccessPolicies.pendingRefresh(personalAgent.id), null);

    await stop();
    await rm(join(root, "fail-refresh"));
    await start();
    await done(await send(personalAgent.id, "Recover with the saved policy"));
    assert.equal(store.agentAccessPolicies.pendingRefresh(personalAgent.id), null);
    assert.notEqual(privateSession(personalAgent), old);
    assert.ok(!handedServers(personalAgent).includes("personal_mail"));
    return { saved: true, persistedStartGate: true, recovered: true };
  });

  await step("Deleting a populated group preserves agents, history, and separate controls", async () => {
    const history = database.readConversation(personalAgent.id, personalAgent.threadId).messages;
    const remove = await revision({ kind: "deletePolicy", policyId: personalGroup.id, destinationPolicyId: null });
    assert.ok((await preview(remove)).changes.some(({ agentId }) => agentId === personalAgent.id));
    const deleted = await apply(remove);
    assert.equal(member(deleted.snapshot, personalAgent.id).policyId, null);
    assert.equal(member(deleted.snapshot, personalAgent.id).overrides[personal], false);

    assert.equal(agents.listAgents().find(({ id }) => id === personalAgent.id)?.threadId, personalAgent.threadId);
    assert.deepEqual(database.readConversation(personalAgent.id, personalAgent.threadId).messages, history);
    assert.equal(readFileSync(workspaceFile, "utf8"), "Personal workspace fixture.\n");
    assert.deepEqual(
      sidebar.getSnapshot().agentAssignments[personalAgent.id],
      beforeSidebar.agentAssignments[personalAgent.id],
    );

    assert.equal(agents.agentAccessPolicy.allows(personalAgent.id, COMPUTER_USE_MCP_SERVER_ID), true);
    assert.equal(
      agentComputerUseEnabled(agents.listAgents().find(({ id }) => id === personalAgent.id) ?? {}),
      agentComputerUseEnabled(personalAgent),
    );
    assert.equal(
      deleted.snapshot.connections.some(({ id }) => id === COMPUTER_USE_MCP_SERVER_ID),
      false,
    );
    return {
      messages: history.length,
      workspacePreserved: true,
      sidebarAssignmentPreserved: true,
      computerUseSeparate: true,
    };
  });

  await step("Stdio handoff and host probe enforce the same group choice", async () => {
    const config: McpServerConfig = {
      id: "",
      name: "fixture_stdio",
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixture, root, "--mcp"],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: "",
      headers: [],
    };
    const rows = await runCauseEffect(agents.saveMcpServer({ config }));
    const row = rows.find(({ name }) => name === config.name);
    assert.ok(row);

    await save(assign(workAgent.id, workGroup.id));
    assert.equal(agents.agentAccessPolicy.allows(workAgent.id, row.id), false);
    const before = providerLog().length;
    assert.equal((await tool(workAgent.id, "test_mcp_server", { name: row.name })).success, false);
    assert.ok(
      !providerLog()
        .slice(before)
        .some(({ kind }) => kind.startsWith("stdio:")),
    );
    assert.ok(!handedServers(workAgent).includes(row.name));

    await save(override(workAgent.id, row.id, true));
    assert.equal((await tool(workAgent.id, "test_mcp_server", { name: row.name })).success, true);
    assert.ok(handedServers(workAgent).includes(row.name));
    const methods = providerLog()
      .slice(before)
      .map(({ kind }) => kind)
      .filter((kind) => kind.startsWith("stdio:"));
    assert.ok(methods.includes("stdio:tools/list"));
    return { deniedSpawn: false, allowedMethods: methods };
  });

  await step("A native Codex MCP entry still replaces a session and stays disabled in its handoff", async () => {
    const before = privateSession(workAgent);
    assert.ok(before);
    const current = readCodexConfig();
    assert.equal(current.fixture_native, undefined);
    await writeFile(codexConfig, JSON.stringify({ ...current, fixture_native: { url, enabled: true } }));
    await done(await send(workAgent.id, "After changing the native Codex configuration"));
    assert.notEqual(privateSession(workAgent), before);
    assert.equal(handoff(workAgent).fixture_native?.enabled, false);
    return { sessionReplaced: true, nativeEntryDisabled: true };
  });

  await step("Revoking a Codex approval for this agent's MCP tool still replaces its session", async () => {
    const before = privateSession(workAgent);
    assert.ok(before);
    const current = readCodexConfig();
    const placeholder = current.fixture_stdio;
    assert.ok(placeholder?.command);
    assert.equal(placeholder.enabled, false);
    await writeFile(
      codexConfig,
      JSON.stringify({
        ...current,
        fixture_stdio: { ...placeholder, tools: { stdio_echo: { approval_mode: "approve" } } },
      }),
    );
    await done(await send(workAgent.id, "After approving the tool"));
    assert.equal(privateSession(workAgent), before);

    await writeFile(codexConfig, JSON.stringify(current));
    await done(await send(workAgent.id, "After revoking the tool approval"));
    assert.notEqual(privateSession(workAgent), before);
    return { approvalGrantPreservedSession: true, approvalRevokeReplacedSession: true };
  });

  await step("Deleting a group can move its agents and clear their overrides", async () => {
    const destination = (await save(group("Destination", { [personal]: true }))).policies.find(
      ({ name }) => name === "Destination",
    );
    assert.ok(destination);
    const current = await read();
    const moving = current.agents.filter(({ policyId }) => policyId === workGroup.id);
    const before = agents.listAgents().map(({ id, threadId, workspacePath }) => ({ id, threadId, workspacePath }));
    assert.ok(moving.length > 1);

    const deletion = await revision({
      kind: "deletePolicy",
      policyId: workGroup.id,
      destinationPolicyId: destination.id,
    });
    const planned = await preview(deletion);
    assert.equal(planned.changes.length, moving.length);
    assert.ok(planned.overridesRemoved > 0);
    const moved = await apply(deletion);
    assert.equal(moved.status, "saved");

    for (const agent of moving) {
      assert.equal(member(moved.snapshot, agent.id).policyId, destination.id);
      assert.deepEqual(member(moved.snapshot, agent.id).overrides, {});
      assert.equal(choice(moved.snapshot, agent.id, personal).allowed, true);
    }
    assert.deepEqual(
      agents.listAgents().map(({ id, threadId, workspacePath }) => ({ id, threadId, workspacePath })),
      before,
    );
    return { agentsMoved: moving.length, overridesRemoved: planned.overridesRemoved };
  });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
} finally {
  await stop();
  await runCauseEffect(oauth.close());
  await new Promise<void>((done) => http.close(() => done()));

  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch((error: Error) => {
    if (process.platform !== "win32" || !("code" in error) || error.code !== "EBUSY") throw error;
    process.stderr.write(`Could not remove the temporary profile. ${error.message}\n`);
  });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
}
