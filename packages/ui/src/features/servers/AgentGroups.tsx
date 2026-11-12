import {
  AGENT_ACCESS_POLICY_NAME_LIMIT,
  type AgentAccessPolicyConnection,
  type AgentAccessPolicyMutation,
  type AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import {
  Button,
  ChevronRight,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  Switch,
  SwitchField,
  Text,
  TriangleAlert,
} from "@openbot/ui";
import { createEffect, createMemo, createSignal, createStore, For, Show, untrack } from "solid-js";
import { useText } from "../../text";
import {
  type AgentAccessPolicyCalls,
  type AgentAccessPolicyResource,
  AgentAccessPolicyReview,
  AgentAccessPolicyStatus,
  createAgentAccessPolicyResource,
} from "./agent-access-policy-resource";

export type { AgentAccessPolicyCalls } from "./agent-access-policy-resource";

export function AgentGroupPicker(props: {
  policies: AgentAccessPolicySnapshot["policies"];
  value: string | null | undefined;
  disabled?: boolean;
  label?: string;
  onChange: (id: string | null) => void;
}) {
  const { t } = useText();
  type Option = { id: string | null; name: string };
  const options = createMemo<Option[]>(() => [
    { id: null, name: t("server.agentGroups.noGroup") },
    ...props.policies.map(({ id, name }) => ({ id, name })),
  ]);

  return (
    <Select<Option>
      options={options()}
      value={options().find((option) => option.id === props.value) ?? null}
      optionValue={(option) => (option.id === null ? "none" : `policy:${option.id}`)}
      optionTextValue={(option) => option.name}
      placeholder={t("server.agentGroups.chooseDestination")}
      disallowEmptySelection
      allowDuplicateSelectionEvents
      disabled={props.disabled}
      placement="bottom-end"
      onChange={(option) => {
        if (option) props.onChange(option.id);
      }}
      itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue.name}</SelectItem>}
    >
      <SelectTrigger aria-label={props.label ?? t("server.agentGroups.group")}>
        <SelectValue<Option>>{(value) => value.selectedOption()?.name}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

function ConnectionLabel(props: { connection: AgentAccessPolicyConnection }) {
  const { t } = useText();
  return (
    <>
      <ItemTitle>{props.connection.name}</ItemTitle>
      <Show when={props.connection.accountLabel}>
        <ItemDescription>{props.connection.accountLabel}</ItemDescription>
      </Show>
      <Show when={!props.connection.available}>
        <ItemDescription>{t("server.agentGroups.unavailable")}</ItemDescription>
      </Show>
    </>
  );
}

export interface AgentAccessPolicySelection {
  serverId: string;
  policyId: string;
  expectedRevision: number;
}

export function AgentGroupCreationField(props: {
  calls: AgentAccessPolicyCalls;
  value: AgentAccessPolicySelection | undefined;
  disabled: boolean;
  onChange: (value: AgentAccessPolicySelection | undefined) => void;
}) {
  const { t } = useText();
  const resource = createAgentAccessPolicyResource(() => props.calls);
  const [selectionCleared, setSelectionCleared] = createSignal(false);

  createEffect(
    () => {
      const data = resource.state.data;
      const selection = props.value;
      if (!selection || !data) return undefined;

      const { serverId, policyId, expectedRevision } = selection;
      if (serverId !== props.calls.serverId || !data.policies.some((policy) => policy.id === policyId)) {
        return { kind: "clear" } as const;
      }

      return expectedRevision === data.revision
        ? undefined
        : ({ kind: "replace", selection: { serverId, policyId, expectedRevision: data.revision } } as const);
    },
    (change) => {
      if (change?.kind === "clear") {
        setSelectionCleared(true);
        untrack(() => props.onChange(undefined));
      } else if (change?.kind === "replace") {
        untrack(() => props.onChange(change.selection));
      }
    },
  );

  return (
    <SettingsSection title={t("server.agentGroups.group")}>
      <AgentAccessPolicyStatus resource={resource} />
      <Show when={resource.state.data}>
        {(data) => (
          <AgentGroupPicker
            policies={data().policies}
            value={props.value?.policyId ?? null}
            disabled={props.disabled || resource.state.busy}
            onChange={(policyId) => {
              setSelectionCleared(false);
              props.onChange(
                policyId === null
                  ? undefined
                  : {
                      serverId: props.calls.serverId,
                      policyId,
                      expectedRevision: data().revision,
                    },
              );
            }}
          />
        )}
      </Show>
      <Show when={selectionCleared()}>
        <Text variant="caption" tone="muted" role="status">
          {t("server.agentGroups.selectionCleared")}
        </Text>
      </Show>
      <Show when={props.value}>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={props.disabled || resource.state.busy}
          onClick={() => void resource.reload()}
        >
          {t("server.agentGroups.reload")}
        </Button>
      </Show>
    </SettingsSection>
  );
}

export interface AgentMcpPermissionsOptions {
  calls: AgentAccessPolicyCalls;
  onViewGroups: (trigger: HTMLElement) => void;
}

export function AgentMcpPermissions(props: AgentMcpPermissionsOptions & { agentId: string }) {
  return (
    <Show when={props.agentId} keyed>
      {(agentId) => (
        <AgentMcpPermissionsForAgent agentId={agentId} calls={props.calls} onViewGroups={props.onViewGroups} />
      )}
    </Show>
  );
}

function AgentMcpPermissionsForAgent(props: AgentMcpPermissionsOptions & { agentId: string }) {
  const { t, format } = useText();
  const resource = createAgentAccessPolicyResource(() => props.calls);

  const data = () => resource.state.data;
  const agent = () => data()?.agents.find((agent) => agent.id === props.agentId);
  const policy = () => data()?.policies.find((policy) => policy.id === agent()?.policyId);
  const overrides = () => Object.keys(agent()?.overrides ?? {}).length;
  const differences = () =>
    agent()?.connections.filter(
      (row) => row.override !== null && row.groupValue !== null && row.override !== row.groupValue,
    ).length ?? 0;

  type AgentChange = Extract<AgentAccessPolicyMutation, { agentId: string }>;
  function change(
    mutation:
      | Omit<Extract<AgentChange, { kind: "resetOverrides" }>, "expectedRevision" | "agentId">
      | Omit<Extract<AgentChange, { kind: "setOverride" }>, "expectedRevision" | "agentId">
      | Omit<Extract<AgentChange, { kind: "assignAgent" }>, "expectedRevision" | "agentId">,
  ) {
    const revision = data()?.revision;
    if (revision === undefined) return;

    void resource.preview({ ...mutation, expectedRevision: revision, agentId: props.agentId });
  }

  const summary = () => {
    const group = policy();
    const total = t("server.agentGroups.overrides", { count: overrides() });
    return group
      ? format.list([total, t("server.agentGroups.differs", { count: differences(), name: group.name })])
      : total;
  };

  return (
    <SettingsSection title={t("server.agentGroups.connections")}>
      <AgentAccessPolicyStatus resource={resource} />
      <Show when={agent()}>
        {(current) => (
          <>
            <ItemGroup class="settings-modal-card">
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{t("server.agentGroups.group")}</ItemTitle>
                  <ItemDescription>
                    {policy()
                      ? t("server.agentGroups.groupSource", { name: policy()?.name ?? "" })
                      : t("server.agentGroups.noGroupSource")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <AgentGroupPicker
                    value={current().policyId}
                    policies={data()?.policies ?? []}
                    disabled={resource.state.busy}
                    onChange={(policyId) => {
                      if (policyId !== current().policyId)
                        change({ kind: "assignAgent", policyId, keepOverrides: false });
                    }}
                  />
                </ItemActions>
              </Item>
              <Item class="settings-modal-row">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => props.onViewGroups(event.currentTarget)}
                >
                  {t("server.agentGroups.viewGroups")}
                </Button>
              </Item>
              <Show when={overrides() > 0}>
                <Item class="settings-modal-row agent-access-policy-summary">
                  <ItemContent>
                    <ItemTitle>{summary()}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={resource.state.busy}
                      onClick={() => change({ kind: "resetOverrides" })}
                    >
                      {t(policy() ? "server.agentGroups.sync" : "server.agentGroups.reset")}
                    </Button>
                  </ItemActions>
                </Item>
              </Show>
            </ItemGroup>
            <ItemGroup class="settings-modal-card">
              <For each={current().connections} fallback={<EmptyRow />}>
                {(row) => {
                  const connection = () => data()?.connections.find((entry) => entry.id === row.connectionId);
                  const different = () =>
                    row.override !== null && row.groupValue !== null && row.override !== row.groupValue;

                  const source = () => {
                    const name = policy()?.name;
                    if (!name)
                      return t(row.source === "override" ? "server.agentGroups.custom" : "server.agentGroups.default");
                    if (row.source !== "override") return t("server.agentGroups.inherited", { name });
                    if (different())
                      return t(row.groupValue ? "server.agentGroups.differentOn" : "server.agentGroups.differentOff", {
                        name,
                      });
                    return t("server.agentGroups.matches", { name });
                  };

                  return (
                    <Show when={connection()}>
                      {(entry) => (
                        <Item class="settings-modal-row">
                          <ItemContent>
                            <ConnectionLabel connection={entry()} />
                            <ItemDescription class="agent-access-policy-source">
                              <Show when={different()}>
                                <TriangleAlert aria-hidden="true" />
                              </Show>
                              {source()}
                            </ItemDescription>
                            <Show when={row.override !== null}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={resource.state.busy}
                                onClick={() =>
                                  change({ kind: "setOverride", connectionId: row.connectionId, allowed: null })
                                }
                              >
                                {t(policy() ? "server.agentGroups.useGroup" : "server.agentGroups.useDefault")}
                              </Button>
                            </Show>
                          </ItemContent>
                          <ItemActions>
                            <Switch
                              aria-label={
                                entry().accountLabel
                                  ? t("server.agentGroups.connectionLabel", {
                                      name: entry().name,
                                      account: entry().accountLabel ?? "",
                                    })
                                  : entry().name
                              }
                              checked={row.allowed}
                              disabled={resource.state.busy}
                              onChange={(allowed) =>
                                change({ kind: "setOverride", connectionId: row.connectionId, allowed })
                              }
                            />
                          </ItemActions>
                        </Item>
                      )}
                    </Show>
                  );
                }}
              </For>
            </ItemGroup>
          </>
        )}
      </Show>
      <AgentAccessPolicyReview resource={resource}>
        {(review) => {
          const mutation = review.mutation;
          if (mutation.kind !== "assignAgent") return undefined;

          if (mutation.policyId === null) {
            return (
              <Text variant="caption" tone="muted">
                {t("server.agentGroups.removeHint")}
              </Text>
            );
          }

          return (
            <Show when={overrides() > 0}>
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{t("server.agentGroups.keep")}</ItemTitle>
                </ItemContent>
                <Switch
                  aria-label={t("server.agentGroups.keep")}
                  checked={mutation.keepOverrides}
                  disabled={resource.state.busy}
                  onChange={(keepOverrides) => void resource.preview({ ...mutation, keepOverrides }, true)}
                />
              </Item>
            </Show>
          );
        }}
      </AgentAccessPolicyReview>
    </SettingsSection>
  );
}

function EmptyRow() {
  const { t } = useText();
  return (
    <Item class="server-settings-empty-row">
      <ItemContent>
        <ItemDescription>{t("server.agentGroups.connectionEmpty")}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

export function AgentGroupsPanel(props: {
  calls: AgentAccessPolicyCalls;
  onDetail: (detail: { title: string; back: () => void } | null) => void;
}) {
  const { t } = useText();
  const resource = createAgentAccessPolicyResource(() => props.calls);
  const [page, setPage] = createSignal<string | null | undefined>();

  // Seed the draft once per group and revision. A read of the same revision keeps unsaved edits.
  const editor = createMemo(
    () => {
      const data = resource.state.data;
      const policyId = page();
      if (!data || policyId === undefined) return undefined;

      const policy = data.policies.find((policy) => policy.id === policyId);
      return {
        policyId,
        revision: data.revision,
        defaults: { name: policy?.name ?? "", allowNewConnections: policy?.allowNewConnections ?? false },
      };
    },
    { equals: (before, after) => before?.policyId === after?.policyId && before?.revision === after?.revision },
  );

  const list = () => {
    setPage(undefined);
    props.onDetail(null);
  };
  const open = (id: string | null, title: string) => {
    setPage(id);
    props.onDetail({ title, back: list });
  };

  return (
    <>
      <AgentAccessPolicyStatus resource={resource} />
      <Show when={resource.state.data}>
        {(data) => (
          <Show
            when={page() !== undefined}
            fallback={
              <SettingsSection
                title={t("server.agentGroups.title")}
                description={t("server.agentGroups.description")}
                actions={
                  <Button type="button" size="sm" onClick={() => open(null, t("server.agentGroups.create"))}>
                    {t("server.agentGroups.create")}
                  </Button>
                }
              >
                <ItemGroup class="settings-modal-card">
                  <For
                    each={data().policies}
                    fallback={
                      <Item class="server-settings-empty-row">
                        <ItemContent>
                          <ItemDescription>{t("server.agentGroups.empty")}</ItemDescription>
                        </ItemContent>
                      </Item>
                    }
                  >
                    {(policy) => (
                      <Item class="settings-modal-row integrations-hub-row">
                        <Button
                          type="button"
                          variant="ghost"
                          class="integrations-hub-hitarea"
                          aria-label={policy.name}
                          onClick={() => open(policy.id, policy.name)}
                        />
                        <ItemContent>
                          <ItemTitle>{policy.name}</ItemTitle>
                          <ItemDescription>
                            {t(
                              policy.allowNewConnections
                                ? "server.agentGroups.newConnectionsOn"
                                : "server.agentGroups.newConnectionsOff",
                            )}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Text variant="label-sm" tone="muted">
                            {t("server.agentGroups.agentCount", {
                              count: data().agents.filter((agent) => agent.policyId === policy.id).length,
                            })}
                          </Text>
                          <ChevronRight class="integrations-hub-chevron" aria-hidden="true" />
                        </ItemActions>
                      </Item>
                    )}
                  </For>
                </ItemGroup>
              </SettingsSection>
            }
          >
            <Show when={editor()} keyed>
              {(openEditor) => (
                <AgentGroupEditor
                  data={data()}
                  policyId={openEditor.policyId}
                  defaults={openEditor.defaults}
                  resource={resource}
                />
              )}
            </Show>
          </Show>
        )}
      </Show>
      <AgentAccessPolicyReview resource={resource} onSaved={list}>
        {({ mutation, preview }) =>
          mutation.kind === "deletePolicy" && mutation.destinationPolicyId === null && preview.changes.length > 0 ? (
            <Text variant="caption" tone="muted">
              {t("server.agentGroups.removeHint")}
            </Text>
          ) : undefined
        }
      </AgentAccessPolicyReview>
    </>
  );
}

function AgentGroupEditor(props: {
  data: AgentAccessPolicySnapshot;
  policyId: string | null;
  defaults: { name: string; allowNewConnections: boolean };
  resource: AgentAccessPolicyResource;
}) {
  const { t } = useText();
  const policy = createMemo(() => props.data.policies.find((policy) => policy.id === props.policyId));
  type Assignment = Extract<AgentAccessPolicyMutation, { kind: "savePolicy" }>["assignments"][number];
  const [draft, setDraft] = createStore<{
    name: string;
    allowNewConnections: boolean;
    choices: Record<string, boolean>;
    assignments: Record<string, Assignment>;
  }>({
    ...props.defaults,
    choices: {},
    assignments: {},
  });

  const choice = (connectionId: string) => {
    const group = policy();
    return draft.choices[connectionId] ?? group?.choices[connectionId] ?? group?.allowNewConnections ?? false;
  };
  const [deleting, setDeleting] = createSignal(false);
  const [destination, setDestination] = createSignal<string | null>();
  const agents = () => props.data.agents.filter((agent) => agent.policyId === props.policyId);

  function save() {
    const choices = Object.fromEntries(props.data.connections.map(({ id }) => [id, choice(id)]));

    void props.resource.preview({
      kind: "savePolicy",
      expectedRevision: props.data.revision,
      policyId: props.policyId,
      name: draft.name.trim(),
      allowNewConnections: draft.allowNewConnections,
      choices,
      assignments: Object.values(draft.assignments),
    });
  }

  return (
    <Show
      when={props.policyId === null || policy()}
      fallback={<Text role="status">{t("server.agentGroups.gone")}</Text>}
    >
      <SettingsSection title={t("server.agentGroups.name")}>
        <Input
          aria-label={t("server.agentGroups.name")}
          maxlength={AGENT_ACCESS_POLICY_NAME_LIMIT}
          value={draft.name}
          disabled={props.resource.state.busy}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setDraft((draft) => {
              draft.name = value;
            });
          }}
        />
      </SettingsSection>
      <SettingsSection title={t("server.agentGroups.connections")} description={t("server.agentGroups.groupDefault")}>
        <ItemGroup class="settings-modal-card">
          <Item class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("server.agentGroups.newConnections")}</ItemTitle>
            </ItemContent>
            <Switch
              aria-label={t("server.agentGroups.newConnections")}
              checked={draft.allowNewConnections}
              disabled={props.resource.state.busy}
              onChange={(value) =>
                setDraft((draft) => {
                  draft.allowNewConnections = value;
                })
              }
            />
          </Item>
          <For each={props.data.connections} fallback={<EmptyRow />}>
            {(connection) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ConnectionLabel connection={connection} />
                </ItemContent>
                <Switch
                  aria-label={
                    connection.accountLabel
                      ? t("server.agentGroups.connectionLabel", {
                          name: connection.name,
                          account: connection.accountLabel,
                        })
                      : connection.name
                  }
                  checked={choice(connection.id)}
                  disabled={props.resource.state.busy}
                  onChange={(value) =>
                    setDraft((draft) => {
                      draft.choices[connection.id] = value;
                    })
                  }
                />
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
      <SettingsSection title={t("server.agentGroups.assignments")}>
        <ItemGroup class="settings-modal-card">
          <For each={props.data.agents}>
            {(agent) => {
              const assigned = () => agent.policyId === props.policyId && props.policyId !== null;
              const assignment = () => draft.assignments[agent.id];
              const from = () =>
                props.data.policies.find((policy) => policy.id === agent.policyId)?.name ??
                t("server.agentGroups.noGroup");

              return (
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>{agent.name}</ItemTitle>
                    <ItemDescription>{from()}</ItemDescription>
                    <Show when={assignment()?.assigned === false}>
                      <ItemDescription>{t("server.agentGroups.removeHint")}</ItemDescription>
                    </Show>
                    <Show when={assignment()?.assigned && Object.keys(agent.overrides).length > 0}>
                      <SwitchField
                        label={t("server.agentGroups.keep")}
                        checked={assignment()?.keepOverrides ?? false}
                        disabled={props.resource.state.busy}
                        onChange={(keepOverrides) =>
                          setDraft((draft) => {
                            draft.assignments[agent.id] = { agentId: agent.id, assigned: true, keepOverrides };
                          })
                        }
                      />
                    </Show>
                  </ItemContent>
                  <Switch
                    aria-label={agent.name}
                    checked={assignment()?.assigned ?? assigned()}
                    disabled={props.resource.state.busy}
                    onChange={(next) => {
                      const savedAssignment = assigned();

                      setDraft((draft) => {
                        if (next === savedAssignment) delete draft.assignments[agent.id];
                        else draft.assignments[agent.id] = { agentId: agent.id, assigned: next, keepOverrides: false };
                      });
                    }}
                  />
                </Item>
              );
            }}
          </For>
        </ItemGroup>
      </SettingsSection>
      <ItemActions>
        <Button type="button" disabled={props.resource.state.busy || !draft.name.trim()} onClick={save}>
          {t("common.save")}
        </Button>
        <Show when={policy()}>
          <Button
            type="button"
            variant="destructive-ghost"
            disabled={props.resource.state.busy}
            onClick={() => setDeleting(true)}
          >
            {t("server.agentGroups.delete")}
          </Button>
        </Show>
      </ItemActions>
      <Show when={deleting() && policy()}>
        {(current) => (
          <SettingsSection
            title={t("server.agentGroups.delete")}
            description={agents().length > 0 ? t("server.agentGroups.deleteHint") : undefined}
          >
            <Show when={agents().length > 0}>
              <AgentGroupPicker
                policies={props.data.policies.filter((policy) => policy.id !== current().id)}
                value={destination()}
                label={t("server.agentGroups.deleteDestination")}
                onChange={setDestination}
              />
            </Show>
            <ItemActions>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDeleting(false);
                  setDestination(undefined);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                disabled={agents().length > 0 && destination() === undefined}
                onClick={() => {
                  setDeleting(false);

                  void props.resource.preview({
                    kind: "deletePolicy",
                    expectedRevision: props.data.revision,
                    policyId: current().id,
                    destinationPolicyId: destination() ?? null,
                  });
                }}
              >
                {t("server.agentGroups.preview")}
              </Button>
            </ItemActions>
          </SettingsSection>
        )}
      </Show>
    </Show>
  );
}
