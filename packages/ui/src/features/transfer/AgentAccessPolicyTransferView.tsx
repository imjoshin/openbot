import type {
  AgentAccessPolicyTransferMapping,
  AgentAccessPolicyTransferOptions,
  AgentAccessPolicyTransferPreview,
  AgentAccessPolicyTransferSelection,
} from "@openbot/contracts/agent-access-policy-transfer";
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SearchSelect,
  SettingsSection,
  Text,
} from "@openbot/ui";
import { createStore, For, Show } from "solid-js";
import { useText } from "../../text";

type Destination = AgentAccessPolicyTransferOptions["destinationConnections"][number];
type PolicyOption = { id: string | null; name: string };

export function AgentAccessPolicyTransferView(props: {
  selection: AgentAccessPolicyTransferSelection;
  options: AgentAccessPolicyTransferOptions;
  preview: AgentAccessPolicyTransferPreview | undefined;
  error: string | null;
  busy: boolean;
  onPreview: (input: AgentAccessPolicyTransferMapping) => void;
  onImport: () => void;
  onEdit: () => void;
  onBack: () => void;
}) {
  const { t, format } = useText();
  const [draft, setDraft] = createStore<{
    policies: Record<string, string | null>;
    connections: Record<string, string>;
  }>({ policies: {}, connections: {} });
  const label = (connection: Destination) =>
    connection.accountLabel
      ? t("server.agentGroups.connectionLabel", { name: connection.name, account: connection.accountLabel })
      : connection.name;
  const noGroup = () => t("server.agentGroups.noGroup");
  const groups = (): PolicyOption[] => [{ id: null, name: noGroup() }, ...props.options.destinationPolicies];
  const allMapped = () =>
    props.options.agents.every((agent) => Object.hasOwn(draft.policies, agent.key)) &&
    props.options.sourceConnections.every((connection) => Object.hasOwn(draft.connections, connection.id));

  function preview() {
    if (!allMapped() || props.busy) return;
    props.onPreview({
      ...props.selection,
      expectedRevision: props.options.revision,
      agentMappings: Object.entries(draft.policies).map(([key, policyId]) => ({ key, policyId })),
      connectionMappings: Object.entries(draft.connections).map(([sourceId, destinationId]) => ({
        sourceId,
        destinationId,
      })),
    });
  }

  const names = (ids: readonly string[]) =>
    format.list(
      ids.map((id) => {
        const connection = props.options.destinationConnections.find((connection) => connection.id === id);
        return connection ? label(connection) : id;
      }),
    );

  return (
    <>
      <Show when={props.error}>
        <Text as="p" variant="caption" tone="danger" role="alert">
          {props.error}
        </Text>
      </Show>
      <Show
        when={props.preview}
        fallback={
          <>
            <SettingsSection
              title={t("settings.transferMapping.agents")}
              description={t("settings.transferMapping.description")}
            >
              <ItemGroup class="settings-modal-card">
                <For each={props.options.agents}>
                  {(agent) => {
                    const source = () =>
                      props.options.sourcePolicies.find((policy) => policy.id === agent.sourcePolicyId);
                    const selected = () => groups().find((group) => group.id === draft.policies[agent.key]) ?? null;
                    return (
                      <Item class="settings-modal-row">
                        <ItemContent>
                          <ItemTitle>{agent.name}</ItemTitle>
                          <ItemDescription>{source()?.name ?? noGroup()}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <SearchSelect<PolicyOption>
                            options={groups()}
                            value={selected()}
                            label={(group) => group.name}
                            optionValue={(group) => (group.id === null ? "none" : `policy:${group.id}`)}
                            aria-label={agent.name}
                            disabled={props.busy}
                            onChange={(group) =>
                              setDraft((draft) => {
                                draft.policies[agent.key] = group.id;
                              })
                            }
                          >
                            {selected()?.name ?? t("settings.transferMapping.choose")}
                          </SearchSelect>
                        </ItemActions>
                      </Item>
                    );
                  }}
                </For>
              </ItemGroup>
            </SettingsSection>
            <Show when={props.options.sourceConnections.length > 0}>
              <SettingsSection title={t("settings.transferMapping.connections")}>
                <ItemGroup class="settings-modal-card">
                  <For each={props.options.sourceConnections}>
                    {(source) => {
                      const choices = () => {
                        const used = new Set(
                          Object.entries(draft.connections)
                            .filter(([id]) => id !== source.id)
                            .map(([, id]) => id),
                        );
                        return props.options.destinationConnections.filter((connection) => !used.has(connection.id));
                      };
                      const selected = () =>
                        props.options.destinationConnections.find(
                          (connection) => connection.id === draft.connections[source.id],
                        ) ?? null;
                      return (
                        <Item class="settings-modal-row">
                          <ItemContent>
                            <ItemTitle>{label(source)}</ItemTitle>
                          </ItemContent>
                          <ItemActions>
                            <SearchSelect<Destination>
                              options={choices()}
                              value={selected()}
                              label={label}
                              optionValue={(connection) => connection.id}
                              aria-label={label(source)}
                              disabled={props.busy}
                              onChange={(connection) =>
                                setDraft((draft) => {
                                  draft.connections[source.id] = connection.id;
                                })
                              }
                            >
                              {selected() ? label(selected() ?? source) : t("settings.transferMapping.choose")}
                            </SearchSelect>
                          </ItemActions>
                        </Item>
                      );
                    }}
                  </For>
                </ItemGroup>
              </SettingsSection>
            </Show>
            <div class="agent-import-actions instance-transfer-start">
              <Button type="button" loading={props.busy} disabled={!allMapped()} onClick={preview}>
                {t("settings.transferMapping.review")}
              </Button>
              <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onBack}>
                {t("common.back")}
              </Button>
            </div>
          </>
        }
      >
        {(review) => (
          <>
            <SettingsSection title={t("settings.transferMapping.review")}>
              <ItemGroup class="settings-modal-card">
                <For each={review().agents}>
                  {(agent) => (
                    <Item class="settings-modal-row">
                      <ItemContent>
                        <ItemTitle>
                          {props.options.agents.find((item) => item.key === agent.key)?.name ?? agent.key}
                        </ItemTitle>
                        <ItemDescription>
                          {groups().find((group) => group.id === agent.policyId)?.name ?? noGroup()}
                        </ItemDescription>
                        <ItemDescription>
                          {t(
                            agent.allowNewConnections
                              ? "server.agentGroups.newConnectionsOn"
                              : "server.agentGroups.newConnectionsOff",
                          )}
                        </ItemDescription>
                        <Show when={agent.enabledConnectionIds.length > 0}>
                          <ItemDescription>
                            {t("server.agentGroups.enabled", { names: names(agent.enabledConnectionIds) })}
                          </ItemDescription>
                        </Show>
                        <Show when={agent.disabledConnectionIds.length > 0}>
                          <ItemDescription>
                            {t("server.agentGroups.disabled", { names: names(agent.disabledConnectionIds) })}
                          </ItemDescription>
                        </Show>
                      </ItemContent>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </SettingsSection>
            <div class="agent-import-actions instance-transfer-start">
              <Button type="button" loading={props.busy} onClick={props.onImport}>
                {t("settings.transferMapping.import")}
              </Button>
              <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onEdit}>
                {t("settings.transferMapping.edit")}
              </Button>
            </div>
          </>
        )}
      </Show>
    </>
  );
}
