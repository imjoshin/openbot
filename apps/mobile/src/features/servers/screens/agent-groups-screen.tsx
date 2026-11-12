import {
  AGENT_ACCESS_POLICY_NAME_LIMIT,
  type AgentAccessPolicy,
  type AgentAccessPolicyMutation,
  type AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import { router, useLocalSearchParams } from "expo-router";
import { Typography } from "heroui-native";
import { useState } from "react";
import {
  AgentGroupPickerRow,
  AgentPolicyReview,
  AgentPolicyStatus,
  AgentPolicyToggle,
  useAgentPolicyConnectionText,
} from "@/features/servers/components/agent-access-policy-controls";
import { HeaderAddAction } from "@/features/servers/components/header-add-action";
import { type AgentAccessPolicyView, useAgentAccessPolicies } from "@/features/servers/model/use-agent-access-policies";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import { useMobileWorkspaceSelector } from "@/features/workspace/context/mobile-workspace-context";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetSaveAction } from "@/shared/components/sheet-save-action";
import { useText } from "@/shared/lib/text";

export function ServerPermissionsScreen() {
  const { t } = useText();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const roles = useMobileWorkspaceSelector((workspace) => workspace.canManageServerRoles(serverId));
  const groups = useMobileWorkspaceSelector((workspace) => workspace.canManageAgentAccessPolicy(serverId));

  return (
    <SettingsContent>
      <SettingsSection>
        {roles ? (
          <SettingsRow
            supportingText={t("mobile.server.roles.description")}
            onPress={() => router.push({ pathname: "/server-settings/roles", params: { serverId } })}
          >
            <Typography.Paragraph>{t("mobile.server.roles.title")}</Typography.Paragraph>
          </SettingsRow>
        ) : null}
        {groups ? (
          <SettingsRow
            supportingText={t("mobile.server.agentGroups.description")}
            onPress={() => router.push({ pathname: "/server-settings/agent-groups", params: { serverId } })}
          >
            <Typography.Paragraph>{t("mobile.server.agentGroups.title")}</Typography.Paragraph>
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </SettingsContent>
  );
}

export function AgentGroupsScreen() {
  const { t, format } = useText();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const policy = useAgentAccessPolicies(serverId);
  const open = (policyId?: string) =>
    router.push({ pathname: "/server-settings/agent-group", params: { serverId, ...(policyId ? { policyId } : {}) } });

  return (
    <SettingsContent>
      <AgentPolicyStatus policy={policy} />
      {policy.data ? (
        <>
          <HeaderAddAction label={t("mobile.server.agentGroups.create")} onPress={() => open()} />
          {policy.data.policies.length ? (
            <SettingsSection>
              {policy.data.policies.map((group) => (
                <SettingsRow
                  key={group.id}
                  supportingText={format.list([
                    t("mobile.server.agentGroups.agentCount", {
                      count: policy.data?.agents.filter((agent) => agent.policyId === group.id).length ?? 0,
                    }),
                    t(
                      group.allowNewConnections
                        ? "mobile.server.agentGroups.newConnectionsOn"
                        : "mobile.server.agentGroups.newConnectionsOff",
                    ),
                  ])}
                  onPress={() => open(group.id)}
                >
                  <Typography.Paragraph>{group.name}</Typography.Paragraph>
                </SettingsRow>
              ))}
            </SettingsSection>
          ) : (
            <SettingsNote>{t("mobile.server.agentGroups.empty")}</SettingsNote>
          )}
        </>
      ) : null}
    </SettingsContent>
  );
}

export function AgentGroupScreen() {
  const { t } = useText();
  const { serverId, policyId } = useLocalSearchParams<{ serverId: string; policyId?: string }>();
  const policy = useAgentAccessPolicies(serverId);
  const group = policy.data?.policies.find((group) => group.id === policyId);

  return (
    <SettingsContent>
      <AgentPolicyStatus policy={policy} />
      {policy.data ? (
        !policyId || group ? (
          <AgentGroupEditor key={policy.data.revision} group={group} data={policy.data} policy={policy} />
        ) : (
          <SettingsNote>{t("mobile.server.agentGroups.gone")}</SettingsNote>
        )
      ) : null}
    </SettingsContent>
  );
}

function AgentGroupEditor({
  group,
  data,
  policy,
}: {
  group: AgentAccessPolicy | undefined;
  data: AgentAccessPolicySnapshot;
  policy: AgentAccessPolicyView;
}) {
  const { t } = useText();
  const connectionText = useAgentPolicyConnectionText();

  const [name, setName] = useState(group?.name ?? "");
  const [allowNewConnections, setAllowNewConnections] = useState(group?.allowNewConnections ?? false);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  type Assignment = Extract<AgentAccessPolicyMutation, { kind: "savePolicy" }>["assignments"][number];
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [deleting, setDeleting] = useState(false);
  const [destination, setDestination] = useState<string | null>();

  const choice = (id: string) => choices[id] ?? group?.choices[id] ?? group?.allowNewConnections ?? false;
  const groupHasAgents = group !== undefined && data.agents.some((agent) => agent.policyId === group.id);
  const dirty =
    name.trim() !== (group?.name ?? "") ||
    allowNewConnections !== (group?.allowNewConnections ?? false) ||
    Object.keys(choices).length > 0 ||
    Object.keys(assignments).length > 0;

  if (policy.review) {
    const { mutation, preview } = policy.review;
    return (
      <AgentPolicyReview policy={policy} onSaved={() => router.back()}>
        {mutation.kind === "deletePolicy" && mutation.destinationPolicyId === null && preview.changes.length > 0 ? (
          <SettingsNote>{t("mobile.server.agentGroups.removeHint")}</SettingsNote>
        ) : null}
      </AgentPolicyReview>
    );
  }

  if (deleting && group) {
    return (
      <>
        {groupHasAgents ? (
          <SettingsSection footer={t("mobile.server.agentGroups.deleteHint")}>
            <AgentGroupPickerRow
              policies={data.policies.filter((item) => item.id !== group.id)}
              value={destination}
              label={t("mobile.server.agentGroups.deleteDestination")}
              disabled={policy.busy}
              onChange={setDestination}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection>
          <SettingsRow
            disclosure={false}
            disabled={policy.busy || (groupHasAgents && destination === undefined)}
            onPress={() =>
              void policy.requestPreview({
                kind: "deletePolicy",
                expectedRevision: data.revision,
                policyId: group.id,
                destinationPolicyId: destination ?? null,
              })
            }
          >
            <Typography.Paragraph className="text-accent">
              {t("mobile.server.agentGroups.preview")}
            </Typography.Paragraph>
          </SettingsRow>
          <SettingsRow
            disclosure={false}
            onPress={() => {
              setDeleting(false);
              setDestination(undefined);
            }}
          >
            <Typography.Paragraph>{t("common.cancel")}</Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      <SheetFormField
        label={t("mobile.server.agentGroups.name")}
        value={name}
        maxLength={AGENT_ACCESS_POLICY_NAME_LIMIT}
        editable={!policy.busy}
        onChangeText={setName}
      />
      <SheetSaveAction
        dirty={dirty}
        canSave={name.trim().length > 0}
        pending={policy.busy}
        onSave={() =>
          void policy.requestPreview({
            kind: "savePolicy",
            expectedRevision: data.revision,
            policyId: group?.id ?? null,
            name: name.trim(),
            allowNewConnections,
            choices: Object.fromEntries(data.connections.map(({ id }) => [id, choice(id)])),
            assignments: Object.values(assignments),
          })
        }
      />
      <SettingsSection
        title={t("mobile.server.agentGroups.connections")}
        footer={t("mobile.server.agentGroups.groupDefault")}
      >
        <AgentPolicyToggle
          title={t("mobile.server.agentGroups.newConnections")}
          value={allowNewConnections}
          disabled={policy.busy}
          onChange={setAllowNewConnections}
        />
        {data.connections.map((connection) => {
          const label = connectionText(connection);
          return (
            <AgentPolicyToggle
              key={connection.id}
              title={label.name}
              details={label.availability}
              value={choice(connection.id)}
              disabled={policy.busy}
              onChange={(value) => setChoices((choices) => ({ ...choices, [connection.id]: value }))}
            />
          );
        })}
      </SettingsSection>
      {data.agents.length > 0 ? (
        <SettingsSection title={t("mobile.server.agentGroups.assignments")}>
          {data.agents.map((agent) => {
            const assigned = group !== undefined && agent.policyId === group.id;
            const assignment = assignments[agent.id];
            const source =
              data.policies.find((group) => group.id === agent.policyId)?.name ??
              t("mobile.server.agentGroups.noGroup");

            return (
              <AgentPolicyToggle
                key={agent.id}
                title={agent.name}
                details={assignment?.assigned === false ? t("mobile.server.agentGroups.removeHint") : source}
                value={assignment?.assigned ?? assigned}
                disabled={policy.busy}
                action={
                  assignment?.assigned && Object.keys(agent.overrides).length
                    ? {
                        label: t(
                          assignment.keepOverrides
                            ? "mobile.server.agentGroups.clear"
                            : "mobile.server.agentGroups.keep",
                        ),
                        run: () =>
                          setAssignments((current) => ({
                            ...current,
                            [agent.id]: { ...assignment, keepOverrides: !assignment.keepOverrides },
                          })),
                      }
                    : undefined
                }
                onChange={(next) =>
                  setAssignments((current) => {
                    const draft = { ...current };
                    if (next === assigned) delete draft[agent.id];
                    else draft[agent.id] = { agentId: agent.id, assigned: next, keepOverrides: false };

                    return draft;
                  })
                }
              />
            );
          })}
        </SettingsSection>
      ) : null}
      {group ? (
        <SettingsSection>
          <SettingsRow disclosure={false} disabled={policy.busy} onPress={() => setDeleting(true)}>
            <Typography.Paragraph className="text-danger-text">
              {t("mobile.server.agentGroups.delete")}
            </Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ) : null}
    </>
  );
}
