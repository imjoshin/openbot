import { AgentAccessPolicyCreateInputSchema } from "@openbot/contracts/agent-access-policy";
import {
  decodeAgentAccessPolicyTransferMapping,
  decodeAgentAccessPolicyTransferSelection,
} from "@openbot/contracts/agent-access-policy-transfer";
import { type CreateAgentWithAccessPolicyInput, decodeAgentAccessPolicyMutation } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";
import { parseCreateAgent } from "./agent-inputs";
import { isObject } from "./validation";

export function parseAgentAccessPolicyMutation(value: unknown) {
  return parsePolicyPayload(decodeAgentAccessPolicyMutation, value);
}

export function parseAgentAccessPolicyTransferSelection(value: unknown) {
  return parsePolicyPayload(decodeAgentAccessPolicyTransferSelection, value);
}

export function parseAgentAccessPolicyTransferMapping(value: unknown) {
  return parsePolicyPayload(decodeAgentAccessPolicyTransferMapping, value);
}

function parsePolicyPayload<A>(decode: (value: unknown) => A, value: unknown): A {
  try {
    return decode(value);
  } catch {
    throw new Error(sourceText("error.team.agentAccessPolicyInvalid"));
  }
}

const decodeCreateChoice = Schema.decodeUnknownSync(AgentAccessPolicyCreateInputSchema);

export function parseCreateAgentWithAccessPolicy(value: unknown): CreateAgentWithAccessPolicyInput {
  try {
    if (!isObject(value)) throw new Error();
    const { policyId, expectedRevision } = decodeCreateChoice(value);
    if (policyId === null) throw new Error();
    return { agent: parseCreateAgent(value.agent, { allowEmptyDescription: true }), policyId, expectedRevision };
  } catch {
    throw new Error(sourceText("error.team.agentAccessPolicyInvalid"));
  }
}
