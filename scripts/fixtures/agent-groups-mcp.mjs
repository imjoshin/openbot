import { createInterface } from "node:readline";

const account = process.argv[2] === "personal" ? "personal" : "work";
const name = `${account}_notes`;
const notes = account === "work" ? "Plan the product review for Thursday." : "Plan a weekend walk by the lake.";

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, "id")) return;
  const send = (reply) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);

  switch (request.method) {
    case "initialize":
      send({
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
          serverInfo: { name, version: "1.0.0" },
          capabilities: { tools: {} },
        },
      });
      break;
    case "ping":
      send({ result: {} });
      break;
    case "tools/list":
      send({
        result: {
          tools: [
            {
              name,
              description: `Read the ${account} demo note.`,
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
      break;
    case "tools/call":
      if (request.params?.name === name) send({ result: { content: [{ type: "text", text: notes }] } });
      else send({ error: { code: -32602, message: "Unknown tool." } });
      break;
    default:
      send({ error: { code: -32601, message: "Unknown method." } });
  }
});
