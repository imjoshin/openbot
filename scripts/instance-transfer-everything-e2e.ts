// Moves a whole setup between two OpenBot profiles with the real transfer service and checks what
// arrives. Two real agent services run on temporary profiles with a fake Codex app-server.
//
// The source has two agents with memories, routines, a chat with a file, a side thread made by a
// branch, settings that only restrict, and a channel with both agents, a lead, a memory and a routine.
// The export includes workspace files, server settings and chat history. The import goes into the
// second profile. The check asserts the agents, memories, routines, settings, the channel, the chat
// messages in order with the file's bytes, the side thread, and that the first turn of an imported
// agent gets the imported history. It also checks that `Shared/Transfers` is not copied as files.
// `bun scripts/instance-transfer-everything-e2e.ts`. Writes .openbot-build/instance-transfer-everything-e2e/report.json.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentAccessPolicyActor } from "@openbot/contracts/agent-access-policy";
import type { AgentAccessPolicyTransferMapping } from "@openbot/contracts/agent-access-policy-transfer";
import { AGENT_PROVIDERS, type AgentEvent, type AgentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/instance-transfer-everything-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-transfer-everything-"));
const fakeCodex = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
const fakeCodexSource = process.platform === "win32" ? join(root, "codex.cjs") : fakeCodex;
const fakeLog = join(root, "codex.jsonl");
const home = join(root, "home");

// Before the service modules load: the Codex process reads these.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { HISTORY_IMPORTED_EVENT } = await import("../src/backend/agent-history-transfer");
const { InstanceTransferService } = await import("../src/main/instance-transfer-service");
const { LocalSkillLibrary } = await import("../src/main/local-skill-library");
const { WorkflowStore } = await import("../src/backend/workflows/workflow-store");
const { workflowScheduleDueAt } = await import("../src/backend/workflows/workflow-triggers");
const { HostEventsService } = await import("../src/main/host-events-service");

const HISTORY_MARK = "the blue notebook is on the second shelf";
const POLICY_ACTOR: AgentAccessPolicyActor = { role: "owner", userId: "transfer-e2e-owner" };

/** A Codex app-server that answers each turn with "Done." and logs what each turn starts with. */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start":
      appendFileSync(LOG, JSON.stringify({ method: "thread/start", params }) + "\\n");
      return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      appendFileSync(LOG, JSON.stringify({ method: "turn/start", params }) + "\\n");
      const turnId = "turn-" + process.pid + "-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      return setTimeout(() => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 20);
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
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

const report: {
  checks: { name: string; passed: boolean; detail?: string }[];
  exportWarnings?: string[];
  importWarnings?: string[];
  archiveEntries?: number;
  passed: boolean;
  error?: string;
} = { checks: [], passed: false };

function pass(name: string, condition: boolean, detail?: string) {
  report.checks.push({ name, passed: condition, ...(detail ? { detail } : {}) });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
}

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function codexLog(): Array<{ method: string; params: unknown }> {
  try {
    return readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** One OpenBot profile: its database, stores, agent service and transfer service. */
function profile(name: string) {
  const userData = join(root, name, "user-data");
  const profileHome = join(root, name, "home");
  mkdirSync(profileHome, { recursive: true });
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, profileHome, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    timezone: () => "UTC",
  });
  const library = new LocalSkillLibrary(join(userData, "local-skills"), () => agents.listAgents());
  const workflows = new WorkflowStore({ database, nextDueAt: workflowScheduleDueAt(() => "UTC") });
  const events = new HostEventsService({
    routines: agents.routineRecords,
    cipher: {
      encrypt: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decrypt: (value) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
    },
    relay: {
      connected: () => true,
      setEnabled: () => {},
      setAccountActive: () => {},
      refresh: () => {},
      ensureHost: () => Effect.void,
      registerRoute: (routeId) => Effect.succeed(`https://signal.example.test/v1/webhooks/${routeId}`),
      revokeRoute: () => Effect.void,
    },
    accountPrincipal: () => "account-1",
  });
  const positions = new Map<string, { nodeKey: string; x: number; y: number }[]>();
  const pins = new Set<string>();
  const levels = new Map<string, "all" | "needs-me" | "nothing">();
  const approvals = new Map<string, boolean>();
  const transfer = new InstanceTransferService({
    agents,
    skills: { library: () => library, installLocal: () => Effect.void },
    sharedRoot: store.sharedRoot,
    channelActor: () => ({ id: "local", name: "You" }),
    webhookRoutines: {
      list: (owner) => events.listRoutines({ owner }),
      save: (input) => events.saveRoutine(input),
    },
    preferences: {
      notificationLevel: (agentId) => levels.get(agentId) ?? null,
      setNotificationLevel: (agentId, level) => Effect.sync(() => levels.set(agentId, level)),
      pinned: (agentId) => pins.has(agentId),
      pin: (agentId) => Effect.sync(() => pins.add(agentId)),
      autoApproves: (agentId) => approvals.get(agentId) ?? true,
      setAutoApprove: (agentId, value) => Effect.sync(() => approvals.set(agentId, value)),
      apiKeyNames: () => Effect.succeed(["WEATHER_API_KEY"]),
    },
    appVersion: "e2e",
    timezone: () => "UTC",
    settings: {
      mcpServers: () => agents.listMcpServers(),
      saveMcpServer: (config) => agents.saveMcpServer({ config }).pipe(Effect.asVoid),
      createMcpServerForTransfer: (config) => agents.createMcpServerForTransfer(config),
      customProviders: () => [],
      saveCustomProvider: () => Effect.void,
      customAgents: () => Effect.succeed([]),
      providersOff: () => AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
      sidebar: () => ({ revision: 0, sections: [], order: [], agentAssignments: {}, agentOrder: [] }),
      mutateSidebar: () => Effect.die("The check has no sidebar sections."),
      routineFlowLinks: () => Effect.succeed([]),
      connectRoutineFlow: () => Effect.die("The check has no routine flows."),
      routineFlowPositions: (agentId) => Effect.succeed(positions.get(agentId) ?? []),
      saveRoutineFlowPosition: (input) =>
        Effect.sync(() =>
          positions.set(input.agentId, [
            ...(positions.get(input.agentId) ?? []),
            { nodeKey: input.nodeKey, x: input.x, y: input.y },
          ]),
        ),
      workflows: {
        workflows: () =>
          Effect.sync(() => workflows.listWithGraphs().map(({ summary, graph }) => ({ title: summary.title, graph }))),
        createWorkflow: (input) => Effect.try(() => workflows.create(input)),
      },
      signedInProviders: () => [],
    },
  });
  return { database, store, mailbox, agents, transfer, pins, levels, approvals, workflows, events, positions };
}

function idle(agents: InstanceType<typeof AgentService>, agentId: string) {
  return waitFor("the turn to end", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

try {
  await writeFile(fakeCodexSource, FAKE_CODEX, { mode: 0o755 });
  if (process.platform === "win32") await writeFile(fakeCodex, '@echo off\r\nnode "%~dp0codex.cjs" %*\r\n');
  const source = profile("source");
  const target = profile("target");
  await runCauseEffect(source.agents.initialize());
  await runCauseEffect(target.agents.initialize());

  // --- The source setup.
  const create = (name: string) =>
    runCauseEffect(
      source.agents.createAgentProfile({
        name,
        description: `${name} agent.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
      }),
    );
  const writer = await create("Writer");
  const editor = await create("Editor");
  source.agents.createMemory({ agentId: writer.id, text: "The user writes in British English." });
  const routine = source.agents.createRoutine({
    agentId: writer.id,
    name: "Morning notes",
    instruction: "Summarise yesterday's notes.",
    active: true,
    timezone: "UTC",
    schedule: { kind: "daily", time: "08:00" },
  });
  await runCauseEffect(source.agents.updateAgent({ agentId: editor.id, computerUse: false, allowAutomation: true }));
  source.pins.add(writer.id);
  source.levels.set(writer.id, "needs-me");
  source.approvals.set(editor.id, false);

  // A real chat turn with a file, then a branch of it as a side thread.
  const notePath = join(root, "shelf-note.txt");
  const noteBytes = new TextEncoder().encode(`Note: ${HISTORY_MARK}.\n`);
  await writeFile(notePath, noteBytes);
  const drafts = await runCauseEffect(source.mailbox.prepareAttachments([notePath]));
  await runCauseEffect(
    source.agents.sendMessage({
      agentId: writer.id,
      text: `Remember: ${HISTORY_MARK}.`,
      attachmentDraftIds: drafts.map((draft) => draft.id),
    }),
  );
  await idle(source.agents, writer.id);
  const sourceHistory = source.agents.readTransferHistory(writer.id);
  const sourceMain = sourceHistory.find((thread) => thread.main);
  assert.ok(sourceMain, "The source chat has no messages.");
  const answer = sourceMain.messages.findLast((message) => message.author === "assistant");
  assert.ok(answer, "The source chat has no answer.");
  await runCauseEffect(
    source.agents.branchTask(
      { agentId: writer.id, taskId: null, messageId: answer.id, requestId: randomUUID() },
      "local",
    ),
  );
  const sourceThreads = source.agents.readTransferHistory(writer.id);
  pass("source has its chat and a side thread", sourceThreads.length === 2, `${sourceThreads.length} chats`);

  const channel = await runCauseEffect(
    source.agents.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: randomUUID(),
        draft: {
          name: "Newsroom",
          title: "Daily paper",
          instructions: "Write and edit the daily paper.",
          members: [{ agentId: writer.id }, { agentId: editor.id }],
          leadAgentId: editor.id,
          isolated: true,
          icon: { name: "book", hue: 210 },
        },
      },
      { id: "local", name: "You" },
    ),
  );
  // A database can keep channel instructions from before the 2,000-character limit (#5929).
  const longDesk = await runCauseEffect(
    source.agents.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: randomUUID(),
        draft: {
          name: "Long desk",
          title: "",
          instructions: "Short.",
          members: [{ agentId: writer.id }],
          leadAgentId: null,
        },
      },
      { id: "local", name: "You" },
    ),
  );
  source.agents.channels.store.update({ ...longDesk, instructions: "x".repeat(2_500) });
  source.agents.createChannelMemory({ channelId: channel.id, text: "Headlines stay under ten words." });
  source.agents.createChannelRoutine({
    channelId: channel.id,
    name: "Evening edition",
    instruction: "Plan the evening edition.",
    active: true,
    timezone: "UTC",
    schedule: { kind: "daily", time: "17:00" },
  });

  // A real message in the channel, which an agent answers.
  await runCauseEffect(
    source.agents.channels.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId: channel.id,
        text: "Plan the front page.",
        // To one member, so no routing turn runs.
        recipientAgentId: writer.id,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      { id: "local", name: "You" },
    ),
  );
  const sourceChannelMessages = await waitFor("an agent answer in the channel", () => {
    const messages = source.agents.channels.store.messages(channel.id);
    return messages.some((entry) => entry.author.kind === "agent" && entry.message.status === "completed") && messages;
  });

  // A routine that a webhook starts, and the places of the routines on the writer's canvas.
  const hooked = await runCauseEffect(
    source.events.saveRoutine({
      owner: { kind: "agent", id: writer.id },
      name: "Breaking news",
      instruction: "Write a short item.",
      active: true,
      timezone: "UTC",
      trigger: { kind: "webhook", eventType: "news.breaking", filters: [] },
    }),
  );
  source.positions.set(writer.id, [
    { nodeKey: `routine:${routine.id}`, x: 120, y: 40 },
    { nodeKey: `routine:${hooked.routine.id}`, x: 320, y: 40 },
    { nodeKey: `agent:${editor.id}`, x: 520, y: 40 },
  ]);

  // A workflow with an agent step, a channel output, a Slack trigger and a webhook trigger.
  const at = { x: 0, y: 0 };
  source.workflows.create({
    title: "Paper pipeline",
    graph: {
      nodes: [
        { id: "hook", kind: "trigger", at, fields: { trigger: "webhook" } },
        {
          id: "slack",
          kind: "trigger",
          at,
          fields: { trigger: "slack", connectionId: "messaging-1", event: "message" },
        },
        { id: "write", kind: "agent", at, fields: { agentId: writer.id, task: "Write it." } },
        { id: "post", kind: "output", at, fields: { target: "chat-channel", channelId: channel.id } },
      ],
      edges: [
        { id: "e1", from: "hook", to: "write", type: "text" },
        { id: "e2", from: "write", to: "post", type: "text" },
      ],
      strokes: [],
    },
  });

  // The same endpoint has two stable connection IDs. Neither test connection can make network calls.
  for (const name of ["work-notes", "personal-notes"]) {
    await runCauseEffect(
      source.agents.saveMcpServer({
        config: {
          id: "",
          name,
          transport: "http",
          enabled: false,
          url: "https://notes.example.test/mcp",
          command: "",
          args: [],
          env: [],
          envPassthrough: [],
          workingDirectory: "",
          headers: [],
        },
      }),
    );
  }

  const workConnection = source.agents.listMcpServers().find(({ name }) => name === "work-notes");
  const personalConnection = source.agents.listMcpServers().find(({ name }) => name === "personal-notes");
  assert.ok(workConnection && personalConnection);

  const policy = source.agents.agentAccessPolicy;
  let policySnapshot = await Effect.runPromise(policy.read(POLICY_ACTOR));
  const savedPolicy = await Effect.runPromise(
    policy.apply(
      {
        kind: "savePolicy",
        expectedRevision: policySnapshot.revision,
        policyId: null,
        name: "Work",
        allowNewConnections: false,
        choices: { [workConnection.id]: true, [personalConnection.id]: false },
        assignments: [{ agentId: writer.id, assigned: true, keepOverrides: false }],
      },
      POLICY_ACTOR,
    ),
  );
  policySnapshot = savedPolicy.snapshot;

  policySnapshot = (
    await Effect.runPromise(
      policy.apply(
        {
          kind: "setOverride",
          expectedRevision: policySnapshot.revision,
          agentId: writer.id,
          connectionId: personalConnection.id,
          allowed: true,
        },
        POLICY_ACTOR,
      ),
    )
  ).snapshot;
  await Effect.runPromise(
    policy.apply(
      {
        kind: "setOverride",
        expectedRevision: policySnapshot.revision,
        agentId: editor.id,
        connectionId: workConnection.id,
        allowed: false,
      },
      POLICY_ACTOR,
    ),
  );

  const individualFile = join(root, "restricted-without-settings.zip");
  await runCauseEffect(
    source.transfer.exportTo(individualFile, {
      agentIds: [writer.id, editor.id],
      includeFiles: false,
      includeSettings: false,
    }),
  );

  // --- Export everything.
  const file = join(root, "transfer.zip");
  const exported = await runCauseEffect(
    source.transfer.exportTo(file, {
      agentIds: [writer.id, editor.id],
      includeFiles: true,
      includeSettings: true,
      includeHistory: true,
    }),
  );
  report.exportWarnings = exported.warnings;
  const { unzipSync, zipSync } = await import("fflate");
  const archive = unzipSync(new Uint8Array(await readFile(file)));
  const transferManifest = JSON.parse(new TextDecoder().decode(archive["openbot-transfer.json"]));
  pass("a restricted export uses version 2 so old importers refuse it", transferManifest.version === 2);
  pass("the export carries both policy memberships", transferManifest.accessPolicy?.memberships.length === 2);

  const individualArchive = unzipSync(new Uint8Array(await readFile(individualFile)));
  const individualManifest = JSON.parse(new TextDecoder().decode(individualArchive["openbot-transfer.json"]));
  pass(
    "an individual restricted export carries policy metadata without server settings",
    individualManifest.version === 2 &&
      individualManifest.settings === null &&
      individualManifest.accessPolicy.memberships.length === 2,
  );
  report.archiveEntries = Object.keys(archive).length;
  pass(
    "Shared/Transfers is not copied as files",
    !Object.keys(archive).some((name) => name.toLowerCase().startsWith("shared/transfers/")),
  );

  // --- Import into the second profile.
  const refusedPreview = await runCauseEffect(target.transfer.stage(file));
  const countBeforeRefusal = target.agents.listAgents().length;
  await assert.rejects(
    runCauseEffect(
      target.transfer.apply({
        token: refusedPreview.token,
        keys: refusedPreview.agents.map(({ key }) => key),
        includeSettings: false,
      }),
    ),
  );
  pass(
    "a restricted import without mapping creates no agents",
    target.agents.listAgents().length === countBeforeRefusal,
  );
  const preview = await runCauseEffect(target.transfer.stage(file));
  pass("preview offers both agents", preview.agents.length === 2);
  // The open views read a channel again on each change that the channel service publishes.
  const published: { channelId: string; revision: number }[] = [];
  target.agents.on("event", (event: AgentEvent) => {
    if (event.type === "channels-changed") published.push({ channelId: event.channelId, revision: event.revision });
  });
  const result = await runCauseEffect(
    target.transfer.apply({
      token: preview.token,
      keys: preview.agents.map((agent) => agent.key),
      includeSettings: true,
    }),
  );
  report.importWarnings = result.warnings;
  pass("both agents are imported", result.agents.length === 2 && result.skipped.length === 0);
  const byName = (name: string): AgentSummary => {
    const agent = target.agents.listAgents().find((candidate) => candidate.name === name);
    assert.ok(agent, `${name} is missing.`);
    return agent;
  };
  const newWriter = byName("Writer");
  const newEditor = byName("Editor");

  const importedPolicy = await Effect.runPromise(target.agents.agentAccessPolicy.read(POLICY_ACTOR));
  const importedWriter = importedPolicy.agents.find(({ id }) => id === newWriter.id);
  const importedEditor = importedPolicy.agents.find(({ id }) => id === newEditor.id);
  const importedWork = importedPolicy.connections.find(({ name }) => name === "work-notes");
  const importedPersonal = importedPolicy.connections.find(({ name }) => name === "personal-notes");
  assert.ok(importedWriter && importedEditor && importedWork && importedPersonal);
  const importedDefaults = importedPolicy.policies.find(({ id }) => id === importedWriter.policyId);
  pass(
    "the group and future-connection default move",
    importedDefaults?.name === "Work" && !importedDefaults.allowNewConnections,
  );
  pass(
    "separate connection IDs are remapped without merging accounts",
    importedWork.id !== importedPersonal.id &&
      importedWork.id !== workConnection.id &&
      importedPersonal.id !== personalConnection.id,
  );
  pass(
    "the inherited allow and explicit exception move",
    importedWriter.connections.some(
      (row) => row.connectionId === importedWork.id && row.allowed && row.source === "policy",
    ) &&
      importedWriter.connections.some(
        (row) =>
          row.connectionId === importedPersonal.id && row.allowed && row.override === true && row.groupValue === false,
      ),
  );
  pass(
    "ungrouped individual denials move",
    importedEditor.policyId === null && importedEditor.overrides[importedWork.id] === false,
  );
  pass(
    "imported connections stay unavailable until the owner enables them",
    !importedWork.available && !importedPersonal.available,
  );

  const collisionPreview = await runCauseEffect(target.transfer.stage(file));
  await assert.rejects(
    runCauseEffect(
      target.transfer.apply({
        token: collisionPreview.token,
        keys: collisionPreview.agents.map(({ key }) => key),
        includeSettings: true,
      }),
    ),
  );
  pass(
    "a same-name connection cannot silently replace a stable-ID mapping",
    target.agents.listAgents().length === countBeforeRefusal + result.agents.length,
  );

  pass(
    "memories move",
    target.agents.listMemories(newWriter.id).some((memory) => memory.text === "The user writes in British English."),
  );
  pass(
    "routines move",
    target.agents.listRoutines(newWriter.id).some((item) => item.name === routine.name && item.active),
  );
  const newHooked = (
    await runCauseEffect(target.events.listRoutines({ owner: { kind: "agent", id: newWriter.id } }))
  ).find((item) => item.name === "Breaking news");
  pass(
    "the webhook routine moves with its event type and a new address",
    newHooked?.trigger.kind === "webhook" &&
      newHooked.trigger.eventType === "news.breaking" &&
      hooked.routine.trigger.kind === "webhook" &&
      newHooked.trigger.url !== hooked.routine.trigger.url,
  );
  pass(
    "the user is told about the new webhook address",
    result.warnings.some((warning) => warning.includes("Breaking news") && warning.includes("webhook")),
  );
  const newRoutineId = target.agents.listRoutines(newWriter.id).find((item) => item.name === routine.name)?.id;
  pass(
    "canvas places point to the new routines and agent",
    JSON.stringify(target.positions.get(newWriter.id)) ===
      JSON.stringify([
        { nodeKey: `routine:${newRoutineId}`, x: 120, y: 40 },
        { nodeKey: `routine:${newHooked?.id}`, x: 320, y: 40 },
        { nodeKey: `agent:${newEditor.id}`, x: 520, y: 40 },
      ]),
    JSON.stringify(target.positions.get(newWriter.id)),
  );
  pass("a restriction moves: Computer Use off", newEditor.computerUse === false);
  pass("a permission does not move: Local scripts stay off", newEditor.allowAutomation !== true);
  pass(
    "the user is told to turn Local scripts on again",
    result.warnings.some((warning) => warning.includes("Local scripts")),
  );
  pass(
    "the pin and the notification level move",
    target.pins.has(newWriter.id) && target.levels.get(newWriter.id) === "needs-me",
  );
  pass("an approval choice that restricts moves", target.approvals.get(newEditor.id) === false);
  pass(
    "no approval warning when this computer already allows the agent",
    !result.warnings.some((warning) => warning.startsWith("Writer:") && warning.includes("always allowed")),
  );
  pass(
    "API key names are listed",
    result.warnings.some((warning) => warning.includes("WEATHER_API_KEY")),
  );

  const channels = target.agents.channels.store.ids().map((id) => target.agents.channels.store.get(id));
  const newChannel = channels.find((item) => item.name === "Newsroom");
  pass("the channel moves", newChannel !== undefined);
  const newLongDesk = channels.find((item) => item.name === "Long desk");
  pass(
    "a channel with long stored instructions moves with the first 2,000 characters and a warning",
    newLongDesk?.instructions.length === 2_000 &&
      exported.warnings.some((warning) => warning.startsWith("Long desk:") && warning.includes("2000")),
    JSON.stringify({ length: newLongDesk?.instructions.length, warnings: exported.warnings }),
  );
  assert.ok(newChannel);
  pass(
    "channel members and lead are the new agents",
    newChannel.members.length === 2 &&
      newChannel.members.every((member) => [newWriter.id, newEditor.id].includes(member.agentId)) &&
      newChannel.leadAgentId === newEditor.id,
  );
  pass("channel settings move", newChannel.isolated === true && newChannel.icon?.name === "book");
  pass(
    "channel memory moves",
    target.agents
      .listChannelMemories(newChannel.id)
      .some((memory) => memory.text === "Headlines stay under ten words."),
  );
  pass(
    "channel routine moves",
    target.agents.listChannelRoutines(newChannel.id).some((item) => item.name === "Evening edition"),
  );

  const newChannelMessages = target.agents.channels.store.messages(newChannel.id);
  pass(
    "channel messages move in order",
    JSON.stringify(newChannelMessages.map((entry) => entry.message.text)) ===
      JSON.stringify(sourceChannelMessages.map((entry) => entry.message.text)),
    JSON.stringify(newChannelMessages.map((entry) => entry.message.text)),
  );
  pass(
    "channel authors are the new agents and the importing person",
    newChannelMessages.every((entry) =>
      entry.author.kind === "agent"
        ? [newWriter.id, newEditor.id].includes(entry.author.id)
        : entry.author.kind !== "member" || entry.author.id === "local",
    ),
  );
  const newSummary = target.agents.channels.store.list("local").find((item) => item.id === newChannel.id);
  pass(
    "the open views get the imported channel messages",
    published.filter((entry) => entry.channelId === newChannel.id).at(-1)?.revision ===
      target.agents.channels.store.get(newChannel.id).revision,
    JSON.stringify(published.filter((entry) => entry.channelId === newChannel.id)),
  );
  pass(
    "imported channel messages are not unread",
    newSummary !== undefined && newSummary.unreadCount === 0,
    JSON.stringify(newSummary),
  );

  const newWorkflow = target.workflows.listWithGraphs().find((item) => item.summary.title === "Paper pipeline");
  pass("the workflow moves", newWorkflow !== undefined);
  const node = (id: string) => newWorkflow?.graph.nodes.find((item) => item.id === id)?.fields;
  pass(
    "workflow steps point to the new agent and channel",
    node("write")?.agentId === newWriter.id && node("post")?.channelId === newChannel.id,
    JSON.stringify(newWorkflow?.graph.nodes.map((item) => item.fields)),
  );
  pass("the workflow's messaging connection is left empty", node("slack")?.connectionId === "");
  pass(
    "the user is told to make the webhook address and choose the connection again",
    result.warnings.some((warning) => warning.startsWith("Paper pipeline:") && warning.includes("webhook")) &&
      result.warnings.some((warning) => warning.startsWith("Paper pipeline:") && warning.includes("connection")),
  );

  // --- The chats.
  const page = await runCauseEffect(target.agents.readConversationPageFor(newWriter.id, "local"));
  const texts = (messages: readonly { text: string }[]) => messages.map((message) => message.text);
  pass(
    "the chat shows the same messages in order",
    JSON.stringify(texts(page.messages)) === JSON.stringify(texts(sourceMain.messages)),
    JSON.stringify({ source: texts(sourceMain.messages), target: texts(page.messages) }),
  );
  pass("the imported chat is not unread", page.readState?.unreadCount === 0, JSON.stringify(page.readState ?? null));
  const sourcePreview = source.agents.listAgents().find((agent) => agent.id === writer.id)?.preview;
  const targetPreview = target.agents.listAgents().find((agent) => agent.id === newWriter.id)?.preview;
  pass(
    "the sidebar shows the same last message",
    Boolean(sourcePreview) && targetPreview === sourcePreview,
    JSON.stringify({ source: sourcePreview, target: targetPreview }),
  );
  const imported = page.messages.find((message) => message.attachments?.length);
  const attachment = imported?.attachments?.[0];
  assert.ok(attachment, "The imported message has no file.");
  const stored = await runCauseEffect(target.mailbox.resolveAttachment(attachment.id));
  pass(
    "the file of the message opens with the same bytes",
    stored !== null && sha(new Uint8Array(await readFile(stored.path))) === sha(noteBytes),
  );
  const targetThreads = target.agents.readTransferHistory(newWriter.id);
  const side = targetThreads.find((thread) => !thread.main);
  pass("the side thread moves", side !== undefined && side.messages.length > 0);
  pass(
    "the side thread is in the side-thread list",
    target.agents.listTasks(newWriter.id).tasks.some((task) => task.title === side?.title),
  );
  pass(
    "the imported chat has the import event",
    newWriter.threadId !== null && target.database.threadHasEvent(newWriter.threadId, HISTORY_IMPORTED_EVENT),
  );

  // --- The first turn of the imported agent gets the history.
  const before = codexLog().length;
  await runCauseEffect(target.agents.sendMessage({ agentId: newWriter.id, text: "Where is the notebook?" }));
  await idle(target.agents, newWriter.id);
  const started = codexLog()
    .slice(before)
    .map((entry) => JSON.stringify(entry.params));
  pass(
    "the first turn of the imported agent gets the imported history",
    started.some((params) => params.includes(HISTORY_MARK)),
  );

  // --- An individual import requires an explicit destination for every source identity.
  await runCauseEffect(
    target.agents.saveMcpServer({
      config: {
        ...workConnection,
        id: "",
        name: "destination-only",
        enabled: false,
      },
    }),
  );

  const individualPreview = await runCauseEffect(target.transfer.stage(individualFile));
  const selection = { token: individualPreview.token, keys: individualPreview.agents.map(({ key }) => key) };
  let options = await runCauseEffect(target.transfer.getTransferMapping(selection));
  assert.ok(options && importedDefaults);
  const destinationOnly = options.destinationConnections.find(({ name }) => name === "destination-only");
  assert.ok(destinationOnly);
  const mapping: AgentAccessPolicyTransferMapping = {
    ...selection,
    expectedRevision: options.revision,
    agentMappings: options.agents.map(({ key, name }) => ({
      key,
      policyId: name === "Writer" ? null : importedDefaults.id,
    })),
    connectionMappings: options.sourceConnections.map(({ id, name }) => {
      const destination = options?.destinationConnections.find((entry) => entry.name === name);
      assert.ok(destination, `No fixture connection for ${name}`);
      return { sourceId: id, destinationId: destination.id };
    }),
  };

  const countBeforeMapping = target.agents.listAgents().length;
  const firstDestination = mapping.connectionMappings[0]?.destinationId;
  assert.ok(firstDestination);
  await assert.rejects(
    runCauseEffect(
      target.transfer.previewTransferMapping({
        ...mapping,
        connectionMappings: mapping.connectionMappings.map((entry) => ({ ...entry, destinationId: firstDestination })),
      }),
    ),
  );
  await assert.rejects(
    runCauseEffect(
      target.transfer.previewTransferMapping({
        ...mapping,
        connectionMappings: mapping.connectionMappings.slice(1),
      }),
    ),
  );
  await assert.rejects(
    runCauseEffect(
      target.transfer.previewTransferMapping({
        ...mapping,
        agentMappings: [],
      }),
    ),
  );
  await assert.rejects(runCauseEffect(target.transfer.getTransferMapping(selection, "different-member")));
  pass(
    "duplicate or missing mappings and another member's token are refused before creation",
    target.agents.listAgents().length === countBeforeMapping,
  );

  await assert.rejects(runCauseEffect(target.transfer.applyTransferMapping(mapping)));
  pass(
    "an import mapping must be previewed before it can apply",
    target.agents.listAgents().length === countBeforeMapping,
  );
  const mappingReview = await runCauseEffect(target.transfer.previewTransferMapping(mapping));
  pass(
    "the preview keeps unmentioned destination connections Off",
    mappingReview.agents.every((agent) => agent.disabledConnectionIds.includes(destinationOnly.id)),
  );
  pass(
    "the preview shows the selected group's future default",
    mappingReview.agents.some((agent) => agent.policyId === null && agent.allowNewConnections) &&
      mappingReview.agents.some((agent) => agent.policyId === importedDefaults.id && !agent.allowNewConnections),
  );

  const destinationPolicy = target.agents.agentAccessPolicy;
  const beforeRename = await Effect.runPromise(destinationPolicy.read(POLICY_ACTOR));
  await Effect.runPromise(
    destinationPolicy.apply(
      {
        kind: "savePolicy",
        expectedRevision: beforeRename.revision,
        policyId: importedDefaults.id,
        name: "Destination Work",
        allowNewConnections: importedDefaults.allowNewConnections,
        choices: importedDefaults.choices,
        assignments: [],
      },
      POLICY_ACTOR,
    ),
  );
  await assert.rejects(runCauseEffect(target.transfer.applyTransferMapping(mapping)));
  pass("a stale import preview creates no agents", target.agents.listAgents().length === countBeforeMapping);

  options = await runCauseEffect(target.transfer.getTransferMapping(selection));
  assert.ok(options);
  const currentMapping = { ...mapping, expectedRevision: options.revision };
  await runCauseEffect(target.transfer.previewTransferMapping(currentMapping));
  const mappedResult = await runCauseEffect(target.transfer.applyTransferMapping(currentMapping));
  pass(
    "explicit mapping imports both selected agents",
    mappedResult.agents.length === 2 && mappedResult.skipped.length === 0,
  );

  const mappedSnapshot = await Effect.runPromise(destinationPolicy.read(POLICY_ACTOR));
  const mappedWriterId = mappedResult.agents.find(({ name }) => name.startsWith("Writer"))?.id;
  const mappedEditorId = mappedResult.agents.find(({ name }) => name.startsWith("Editor"))?.id;
  const mappedWriter = mappedSnapshot.agents.find(({ id }) => id === mappedWriterId);
  const mappedEditor = mappedSnapshot.agents.find(({ id }) => id === mappedEditorId);
  assert.ok(mappedWriter && mappedEditor);
  pass(
    "mapping keeps source exceptions and blocks extra destination connections",
    mappedWriter.policyId === null &&
      mappedWriter.overrides[importedPersonal.id] === true &&
      mappedWriter.overrides[destinationOnly.id] === false &&
      mappedEditor.overrides[destinationOnly.id] === false,
  );
  pass(
    "mapping pins source permissions when the destination group differs",
    mappedEditor.policyId === importedDefaults.id &&
      mappedEditor.overrides[importedWork.id] === false &&
      mappedEditor.overrides[importedPersonal.id] === true,
  );

  for (const [label, invalidManifest] of [
    ["v2 without policy", { ...individualManifest, accessPolicy: undefined }],
    ["v1 with policy", { ...individualManifest, version: 1 }],
    [
      "v2 missing membership",
      { ...individualManifest, accessPolicy: { ...individualManifest.accessPolicy, memberships: [] } },
    ],
  ] as const) {
    const invalidFile = join(root, `${label.replaceAll(" ", "-")}.zip`);
    await writeFile(
      invalidFile,
      zipSync({
        ...individualArchive,
        "openbot-transfer.json": new TextEncoder().encode(JSON.stringify(invalidManifest)),
      }),
    );
    await assert.rejects(runCauseEffect(target.transfer.stage(invalidFile)));
    pass(`${label} fails closed`, true);
  }

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  process.exit();
}
