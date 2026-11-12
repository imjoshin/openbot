import { describe, expect, it } from "vitest";
import {
  decodeAgentAccessPolicyApplyResultFromMain,
  decodeAgentAccessPolicySnapshotFromMain,
  decodeAgentAccessPolicyTransferPreviewFromMain,
} from "./agent-access-policy-decoding";

const snapshot = {
  revision: 1,
  policies: [],
  agents: [],
  connections: [{ id: "connection-1", name: "Work", accountLabel: null, available: true }],
};

describe("agent access policy preload decoding", () => {
  it("keeps connection metadata and removes connection secrets", () => {
    const decoded = decodeAgentAccessPolicySnapshotFromMain({
      ...snapshot,
      connections: [{ ...snapshot.connections[0], token: "fixture-secret", headers: [] }],
    });
    expect(decoded).toEqual(snapshot);
  });

  it("rejects a malformed connection in a successful save response", () => {
    expect(() =>
      decodeAgentAccessPolicyApplyResultFromMain({
        status: "saved",
        snapshot: { ...snapshot, connections: [{ ...snapshot.connections[0], available: "false" }] },
        agentIds: [],
      }),
    ).toThrow();
  });

  it("rejects a prototype name as a mapped connection identifier", () => {
    expect(() =>
      decodeAgentAccessPolicyTransferPreviewFromMain({
        revision: 1,
        agents: [
          {
            key: "agent-1",
            policyId: null,
            allowNewConnections: false,
            enabledConnectionIds: ["__proto__"],
            disabledConnectionIds: [],
          },
        ],
      }),
    ).toThrow();
  });
});
