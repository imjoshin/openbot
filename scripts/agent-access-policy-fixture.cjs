// A Codex app-server stand-in for agent-access-policy-e2e.ts. It uses no account or network.
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const [profile, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\n");
  process.exit(0);
}

const waiting = new Map();
const input = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (message) => appendFileSync(join(profile, "codex.jsonl"), `${JSON.stringify(message)}\n`);
const flag = (name) => existsSync(join(profile, name));
const configPath = join(profile, "codex-config.json");
const savedServers = () => (existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {});

function notify(method, threadId, turnId, details) {
  write({ method, params: { threadId, turnId, ...details } });
}

function finish(threadId, turnId) {
  notify("item/completed", threadId, turnId, {
    item: { type: "agentMessage", id: `msg-${turnId}`, text: "Done.", phase: "final_answer" },
  });
  notify("turn/completed", threadId, turnId, { turn: { id: turnId, status: "completed" } });
}

function afterFlag(name, run) {
  const timer = setInterval(() => {
    if (!flag(name)) return;
    clearInterval(timer);
    run();
  }, 15);
  timer.unref();
}

function startTurn(message, params, reply) {
  const { threadId } = params;
  const turnId = randomUUID();
  const prompt = params.input.map((item) => item.text ?? "").join("\n");
  const text = prompt.split("\n\n--- current message ---\n").at(-1);
  log({ kind: "turn/start", threadId });

  const start = () => {
    reply({ turn: { id: turnId, status: "inProgress", items: [] } });
    notify("turn/started", threadId, turnId, { turn: { id: turnId } });
    notify("thread/tokenUsage/updated", threadId, turnId, {
      tokenUsage: { total: { totalTokens: 1000 }, last: { totalTokens: 1000 }, modelContextWindow: 100000 },
    });
  };

  if (text.includes("HOLD-START")) {
    log({ kind: "starting", threadId });
    return afterFlag("release-start", () => {
      start();
      finish(threadId, turnId);
    });
  }

  start();

  if (text.includes("HOLD-ACTIVE")) {
    log({ kind: "active", threadId });
    return afterFlag("release-active", () => finish(threadId, turnId));
  }

  if (text.includes("HOLD-SUBAGENT")) {
    const child = `child-${turnId}`;
    const spawn = {
      type: "collabAgentToolCall",
      id: `spawn-${turnId}`,
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: threadId,
      receiverThreadIds: [child],
      agentsStates: { [child]: { status: "running", message: null } },
    };

    notify("item/completed", threadId, turnId, { item: spawn });
    return afterFlag("release-subagent", () => {
      notify("item/completed", threadId, turnId, {
        item: {
          ...spawn,
          id: `wait-${turnId}`,
          tool: "wait",
          agentsStates: { [child]: { status: "completed", message: "Done" } },
        },
      });
      finish(threadId, turnId);
    });
  }

  const call = [...text.matchAll(/POLICY-CALL:([A-Za-z0-9+/=]+)/gu)].at(-1);
  if (call) {
    const { name, arguments: toolArguments } = JSON.parse(Buffer.from(call[1], "base64").toString("utf8"));
    const id = `tool-${message.id}`;
    waiting.set(id, { name, threadId, turnId });

    return write({
      id,
      method: "item/tool/call",
      params: {
        threadId,
        turnId,
        callId: id,
        namespace: "openbot",
        tool: name === "tool_search" ? name : "tool_call",
        arguments: name === "tool_search" ? toolArguments : { name: `openbot.${name}`, arguments: toolArguments },
      },
    });
  }

  finish(threadId, turnId);
}

function request(message) {
  const params = message.params ?? {};
  const reply = (result) => write({ id: message.id, result });

  switch (message.method) {
    case "initialize":
    case "thread/archive":
    case "thread/name/set":
      return reply({});
    case "account/read":
      return reply({ account: { type: "chatgpt", email: "codex@example.test" } });
    case "account/rateLimits/read":
      return reply({ rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null });
    case "model/list":
      return reply({ data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] });
    case "plugin/list":
      return reply({ marketplaces: [] });
    case "config/read": {
      const config = { mcp_servers: savedServers() };
      return reply({ config, layers: [{ name: { type: "user", file: configPath }, version: "1", config }] });
    }
    case "config/batchWrite": {
      const next = savedServers();
      for (const edit of params.edits) next[edit.keyPath.slice("mcp_servers.".length)] = edit.value;
      writeFileSync(configPath, JSON.stringify(next));
      return reply({});
    }
    case "thread/start":
    case "thread/resume": {
      const id = params.threadId ?? randomUUID();
      const servers = params.config?.mcp_servers ?? {};
      writeFileSync(join(profile, `handoff-${id}.json`), JSON.stringify(servers), { mode: 0o600 });
      log({ kind: message.method, threadId: id });
      return reply({ thread: { id, turns: [] } });
    }
    case "thread/unsubscribe":
      if (flag("fail-refresh")) {
        log({ kind: "failed-refresh", threadId: params.threadId });
        return write({ id: message.id, error: { code: -32603, message: "Fixture release failure" } });
      }
      return reply({ status: "Unsubscribed" });
    case "thread/backgroundTerminals/list":
    case "thread/turns/list":
    case "thread/items/list":
      return reply({ data: [], nextCursor: null });
    case "thread/read":
      return reply({ thread: { id: params.threadId, turns: [] } });
    case "thread/compact/start": {
      const { threadId } = params;
      const turnId = randomUUID();
      const item = { type: "contextCompaction", id: `compact-${turnId}` };

      reply({});
      notify("turn/started", threadId, turnId, { turn: { id: turnId } });
      notify("item/started", threadId, turnId, { item });
      log({ kind: "compacting", threadId });
      return afterFlag("release-compact", () => {
        notify("item/completed", threadId, turnId, { item });
        notify("turn/completed", threadId, turnId, { turn: { id: turnId, status: "completed" } });
      });
    }
    case "turn/start":
      return startTurn(message, params, reply);
    default:
      return write({ id: message.id, error: { code: -32601, message: `Fixture has no ${message.method}` } });
  }
}

input.on("line", (line) => {
  const message = JSON.parse(line);

  if (args.includes("--mcp")) {
    const results = {
      initialize: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "Policy stdio fixture", version: "1" },
      },
      "tools/list": { tools: [{ name: "stdio_echo", inputSchema: { type: "object" } }] },
    };
    log({ kind: `stdio:${message.method}` });
    if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, result: results[message.method] ?? {} });
    return;
  }

  if (message.method && message.id !== undefined) request(message);
  if (message.method || !waiting.has(message.id)) return;

  const { name, threadId, turnId } = waiting.get(message.id);
  waiting.delete(message.id);
  log({ kind: "tool", name, threadId, result: message.result ?? null, error: message.error ?? null });
  finish(threadId, turnId);
});
