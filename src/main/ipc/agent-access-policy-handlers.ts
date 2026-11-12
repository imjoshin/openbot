import type { AgentAccessPolicyActor, AgentAccessPolicyMutation } from "@openbot/contracts/agent-access-policy";
import type {
  AgentAccessPolicyTransferMapping,
  AgentAccessPolicyTransferSelection,
} from "@openbot/contracts/agent-access-policy-transfer";
import {
  type CreateAgentWithAccessPolicyInput,
  decodeRemoteInstanceTransferResult,
  LOCAL_SERVER_ID,
  resolveRemoteInstanceTransferResult,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  AGENT_ACCESS_POLICY_CAPABILITY,
  AGENT_ACCESS_POLICY_ROUTES,
} from "@openbot/contracts/team-protocol/agent-access-policy-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostService } from "../host-service";
import type { InstanceTransferService } from "../instance-transfer-service";
import {
  decodeAgentAccessPolicyApplyResultFromHost,
  decodeAgentAccessPolicyPreviewFromHost,
  decodeAgentAccessPolicySnapshotFromHost,
  decodeAgentAccessPolicyTransferOptionsFromHost,
  decodeAgentAccessPolicyTransferPreviewFromHost,
  decodeAgentCreatedWithAccessPolicyFromHost,
} from "../remote-agent-access-policy-decoding";
import { decodeAgentSummaries } from "../remote-agent-decoding";
import { AGENT_IMPORT_UPLOAD_TIMEOUT_MS, type RemoteServerManager } from "../remote-server-manager";
import type { ServerAuditStore } from "../server-audit-store";
import {
  parseAgentAccessPolicyMutation,
  parseAgentAccessPolicyTransferMapping,
  parseAgentAccessPolicyTransferSelection,
  parseCreateAgentWithAccessPolicy,
} from "./agent-access-policy-inputs";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";

interface AgentAccessPolicyIpcDependencies {
  service: Pick<AgentService, "agentAccessPolicy" | "createAgent">;
  host: Pick<HostService, "conversationSender" | "getStatus">;
  remoteServers: Pick<RemoteServerManager, "request" | "supportsCapability">;
  serverAudit: Pick<ServerAuditStore, "record">;
  instanceTransfer: Pick<
    InstanceTransferService,
    "getTransferMapping" | "previewTransferMapping" | "applyTransferMapping"
  >;
}

export function agentAccessPolicyIpcHandlers({
  service,
  host,
  remoteServers,
  serverAudit,
  instanceTransfer,
}: AgentAccessPolicyIpcDependencies): Pick<IpcGroupHandlers, "agentAccessPolicy"> {
  // A trusted desktop renderer runs as the owner of the computer's local agent service.
  const localOwner: AgentAccessPolicyActor = { role: "owner", userId: "local-owner" };
  const policy = service.agentAccessPolicy;
  const routes = AGENT_ACCESS_POLICY_ROUTES;
  function remote<T>(
    serverId: string,
    route: string,
    decode: (value: unknown) => T,
    body:
      | AgentAccessPolicyMutation
      | CreateAgentWithAccessPolicyInput
      | AgentAccessPolicyTransferSelection
      | (AgentAccessPolicyTransferMapping & { timezone?: string })
      | Record<string, never>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, AGENT_ACCESS_POLICY_CAPABILITY)) {
      throw new Error(sourceText("error.team.agentAccessPolicyUnsupported"));
    }
    return runCauseEffect(
      remoteServers.request(serverId, route, decode, {
        method: "POST",
        body,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    );
  }

  function recordChange() {
    return serverAudit.record(host.getStatus().serverId ?? LOCAL_SERVER_ID, host.conversationSender() ?? null, [
      { change: { kind: "agent-access-policy" } },
    ]);
  }

  return {
    agentAccessPolicy: {
      list: scopedQueryHandler({
        local: () => Effect.runPromise(policy.read(localOwner)),
        remote: (serverId) => remote(serverId, routes.list, decodeAgentAccessPolicySnapshotFromHost, {}),
      }),
      preview: scopedHandler(parseAgentAccessPolicyMutation, {
        local: (input) => Effect.runPromise(policy.preview(input, localOwner)),
        remote: (input, serverId) => remote(serverId, routes.preview, decodeAgentAccessPolicyPreviewFromHost, input),
      }),
      apply: scopedHandler(parseAgentAccessPolicyMutation, {
        local: (input) => Effect.runPromise(policy.apply(input, localOwner).pipe(Effect.tap(recordChange))),
        remote: (input, serverId) => remote(serverId, routes.apply, decodeAgentAccessPolicyApplyResultFromHost, input),
      }),
      createAgent: scopedHandler(parseCreateAgentWithAccessPolicy, {
        local: ({ agent, policyId, expectedRevision }) =>
          runCauseEffect(
            service
              .createAgent(agent, undefined, undefined, host.conversationSender(), true, {
                actor: localOwner,
                policyId,
                expectedRevision,
              })
              .pipe(Effect.tap(recordChange)),
          ),
        remote: (input, serverId) =>
          remote(serverId, routes.createAgent, decodeAgentCreatedWithAccessPolicyFromHost, input),
      }),
      getTransferMapping: scopedHandler(parseAgentAccessPolicyTransferSelection, {
        local: (input) => runCauseEffect(instanceTransfer.getTransferMapping(input)),
        remote: (input, serverId) =>
          remote(serverId, routes.getTransferMapping, decodeAgentAccessPolicyTransferOptionsFromHost, input),
      }),
      previewTransferMapping: scopedHandler(parseAgentAccessPolicyTransferMapping, {
        local: (input) => runCauseEffect(instanceTransfer.previewTransferMapping(input)),
        remote: (input, serverId) =>
          remote(serverId, routes.previewTransferMapping, decodeAgentAccessPolicyTransferPreviewFromHost, input),
      }),
      applyTransferMapping: scopedHandler(parseAgentAccessPolicyTransferMapping, {
        local: (input) => runCauseEffect(instanceTransfer.applyTransferMapping(input)),
        remote: async (input, serverId) => {
          const result = await remote(
            serverId,
            routes.applyTransferMapping,
            decodeRemoteInstanceTransferResult,
            {
              ...input,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            AGENT_IMPORT_UPLOAD_TIMEOUT_MS,
          );
          const agents = await runCauseEffect(
            remoteServers.request(serverId, TEAM_API_ROUTES.agents.all, decodeAgentSummaries),
          );
          return resolveRemoteInstanceTransferResult(result, agents);
        },
      }),
    },
  };
}
