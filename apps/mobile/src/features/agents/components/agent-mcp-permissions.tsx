import type { AgentAccessPolicyMutation } from "@openbot/contracts/agent-access-policy";
import { router } from "expo-router";
import { Typography } from "heroui-native";
import {
  AgentGroupPickerRow,
  AgentPolicyReview,
  AgentPolicyStatus,
  AgentPolicyToggle,
  useAgentPolicyConnectionText,
} from "@/features/servers/components/agent-access-policy-controls";
import { useAgentAccessPolicies } from "@/features/servers/model/use-agent-access-policies";
import { SettingsNote, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { useText } from "@/shared/lib/text";

export function AgentMcpPermissions({ agentId, serverId }: { agentId: string; serverId: string }) {
  const { t, format } = useText();
  const policy = useAgentAccessPolicies(serverId);
  const connectionText = useAgentPolicyConnectionText();
  const agent = policy.data?.agents.find((agent) => agent.id === agentId);

  if (!policy.available) return null;
  if (!agent || !policy.data) return <AgentPolicyStatus policy={policy} />;

  const data = policy.data;
  const group = data.policies.find((group) => group.id === agent.policyId);
  const count = Object.keys(agent.overrides).length;
  const differs = agent.connections.filter(
    (row) => row.override !== null && row.groupValue !== null && row.override !== row.groupValue,
  ).length;

  const assign = (policyId: string | null, keepOverrides = false) => {
    if (policyId === agent.policyId) return;

    void policy.requestPreview({
      kind: "assignAgent",
      expectedRevision: data.revision,
      agentId,
      policyId,
      keepOverrides,
    });
  };

  const override = (connectionId: string, allowed: boolean | null) => {
    void policy.requestPreview({
      kind: "setOverride",
      expectedRevision: data.revision,
      agentId,
      connectionId,
      allowed,
    });
  };

  const reset = () => {
    const mutation: AgentAccessPolicyMutation = { kind: "resetOverrides", expectedRevision: data.revision, agentId };
    void policy.requestPreview(mutation);
  };

  if (policy.review) {
    const { mutation } = policy.review;
    return (
      <AgentPolicyReview policy={policy}>
        {mutation.kind === "assignAgent" && mutation.policyId === null ? (
          <SettingsNote>{t("mobile.server.agentGroups.removeHint")}</SettingsNote>
        ) : mutation.kind === "assignAgent" && count > 0 ? (
          <SettingsSection>
            <AgentPolicyToggle
              title={t("mobile.server.agentGroups.keep")}
              value={mutation.keepOverrides}
              disabled={policy.busy}
              onChange={(keep) => assign(mutation.policyId, keep)}
            />
          </SettingsSection>
        ) : null}
      </AgentPolicyReview>
    );
  }

  const summary = t("mobile.server.agentGroups.overrides", { count });
  return (
    <>
      <AgentPolicyStatus policy={policy} />
      <SettingsSection
        title={t("mobile.server.agentGroups.connections")}
        footer={
          group
            ? t("mobile.server.agentGroups.groupSource", { name: group.name })
            : t("mobile.server.agentGroups.noGroupSource")
        }
      >
        <AgentGroupPickerRow policies={data.policies} value={agent.policyId} disabled={policy.busy} onChange={assign} />
        <SettingsRow onPress={() => router.push({ pathname: "/server-settings/agent-groups", params: { serverId } })}>
          <Typography.Paragraph>{t("mobile.server.agentGroups.viewGroups")}</Typography.Paragraph>
        </SettingsRow>
        {count > 0 ? (
          <SettingsRow
            disclosure={false}
            supportingText={
              group
                ? format.list([summary, t("mobile.server.agentGroups.differs", { count: differs, name: group.name })])
                : summary
            }
            disabled={policy.busy}
            onPress={reset}
          >
            <Typography.Paragraph className="text-accent">
              {t(group ? "mobile.server.agentGroups.sync" : "mobile.server.agentGroups.reset")}
            </Typography.Paragraph>
          </SettingsRow>
        ) : null}
      </SettingsSection>
      {agent.connections.length ? (
        <SettingsSection>
          {agent.connections.map((row) => {
            const connection = data.connections.find((item) => item.id === row.connectionId);
            if (!connection) return null;

            const { name, availability } = connectionText(connection);
            const different = row.override !== null && row.groupValue !== null && row.override !== row.groupValue;
            const source = group
              ? t(
                  row.source !== "override"
                    ? "mobile.server.agentGroups.inherited"
                    : different
                      ? row.groupValue
                        ? "mobile.server.agentGroups.differentOn"
                        : "mobile.server.agentGroups.differentOff"
                      : "mobile.server.agentGroups.matches",
                  { name: group.name },
                )
              : t(row.source === "override" ? "mobile.server.agentGroups.custom" : "mobile.server.agentGroups.default");

            return (
              <AgentPolicyToggle
                key={row.connectionId}
                title={name}
                value={row.allowed}
                disabled={policy.busy}
                details={availability ? format.list([source, availability]) : source}
                warning={different}
                action={
                  row.override === null
                    ? undefined
                    : {
                        label: t(group ? "mobile.server.agentGroups.useGroup" : "mobile.server.agentGroups.useDefault"),
                        run: () => override(row.connectionId, null),
                      }
                }
                onChange={(value) => override(row.connectionId, value)}
              />
            );
          })}
        </SettingsSection>
      ) : (
        <SettingsNote>{t("mobile.server.agentGroups.connectionEmpty")}</SettingsNote>
      )}
    </>
  );
}
