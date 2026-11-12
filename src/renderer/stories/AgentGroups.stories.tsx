import type { AgentAccessPolicyConnection } from "@openbot/contracts/agent-access-policy";
import type {
  AgentAccessPolicyTransferOptions,
  AgentAccessPolicyTransferPreview,
} from "@openbot/contracts/agent-access-policy-transfer";
import { AgentMcpPermissions } from "@openbot/ui/features/servers/AgentGroups";
import { AgentAccessPolicyTransferView } from "@openbot/ui/features/transfer/AgentAccessPolicyTransferView";
import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT } from "../src/preview/fixtures";
import { createMockAgentAccessPolicy } from "../src/preview/mock-agent-access-policy";
import { ServerSettingsStory, STORY_REMOTE_SERVER, serverSettingsArgs } from "./server-settings-story";

const connections: AgentAccessPolicyConnection[] = [
  { id: "work-slack", name: "Slack", accountLabel: "Work", available: true },
  { id: "personal-slack", name: "Slack", accountLabel: "Personal", available: true },
  { id: "github", name: "GitHub", accountLabel: "Work", available: false },
  { id: "email", name: "Email", accountLabel: "Work", available: true },
];
const agents = [
  { id: STORY_AGENT.id, name: STORY_AGENT.name },
  { id: "story-admin", name: "Research" },
  { id: "story-free", name: "Calendar" },
] as const;

function storyPolicies(empty = false) {
  return createMockAgentAccessPolicy(
    "local",
    () => agents,
    () => connections,
    empty
      ? undefined
      : {
          policies: [
            {
              id: "work",
              name: "Work",
              revision: 0,
              allowNewConnections: false,
              choices: { "work-slack": true, github: true, email: true },
            },
            {
              id: "personal",
              name: "Personal",
              revision: 0,
              allowNewConnections: false,
              choices: { "personal-slack": true },
            },
          ],
          agents: [
            {
              ...agents[0],
              policyId: "work",
              overrides: { "personal-slack": true, email: false, github: true },
              connections: [],
            },
            { ...agents[1], policyId: "personal", overrides: {}, connections: [] },
            { ...agents[2], policyId: null, overrides: { github: false }, connections: [] },
          ],
        },
  );
}

const meta = {
  title: "Settings/Agent Groups",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Groups: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{ ...serverSettingsArgs(), initialSection: "agent-groups", agentAccessPolicy: storyPolicies() }}
    />
  ),
};

export const Empty: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{ ...serverSettingsArgs(), initialSection: "agent-groups", agentAccessPolicy: storyPolicies(true) }}
    />
  ),
};

export const Unsupported: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{ ...serverSettingsArgs(), server: STORY_REMOTE_SERVER, initialSection: "permissions" }}
    />
  ),
};

export const AgentOverrides: Story = {
  render: () => (
    <main class="agent-memories-story-stage">
      <AgentMcpPermissions agentId={STORY_AGENT.id} calls={storyPolicies()} onViewGroups={() => undefined} />
    </main>
  ),
};

function RestrictedTransferStory() {
  const [preview, setPreview] = createSignal<AgentAccessPolicyTransferPreview>();
  const options: AgentAccessPolicyTransferOptions = {
    revision: 1,
    agents: [{ key: "story-agent", name: STORY_AGENT.name, sourcePolicyId: "work" }],
    sourcePolicies: [{ id: "work", name: "Work", allowNewConnections: false }],
    sourceConnections: [{ id: "source-slack", name: "Slack", accountLabel: "Work" }],
    destinationPolicies: [
      { id: "work", name: "Work", allowNewConnections: false },
      { id: "personal", name: "Personal", allowNewConnections: true },
    ],
    destinationConnections: connections,
  };

  return (
    <main class="agent-memories-story-stage">
      <AgentAccessPolicyTransferView
        selection={{ token: "transfer-story", keys: ["story-agent"] }}
        options={options}
        preview={preview()}
        error={null}
        busy={false}
        onPreview={(input) => {
          const policyId = input.agentMappings[0]?.policyId ?? null;
          const enabledConnectionIds = input.connectionMappings.map(({ destinationId }) => destinationId);

          setPreview({
            revision: input.expectedRevision,
            agents: [
              {
                key: "story-agent",
                policyId,
                allowNewConnections:
                  options.destinationPolicies.find((group) => group.id === policyId)?.allowNewConnections ?? true,
                enabledConnectionIds,
                disabledConnectionIds: connections
                  .filter((connection) => !enabledConnectionIds.includes(connection.id))
                  .map((connection) => connection.id),
              },
            ],
          });
        }}
        onImport={() => undefined}
        onEdit={() => setPreview(undefined)}
        onBack={() => setPreview(undefined)}
      />
    </main>
  );
}

export const RestrictedTransfer: Story = { render: () => <RestrictedTransferStory /> };
