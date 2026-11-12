import type {
  AgentAccessPolicyTransferMapping,
  AgentAccessPolicyTransferOptions,
  AgentAccessPolicyTransferPreview,
  AgentAccessPolicyTransferSelection,
} from "@openbot/contracts/agent-access-policy-transfer";
import { Typography } from "heroui-native";
import { useLayoutEffect, useRef, useState } from "react";
import { useUniwind } from "uniwind";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import { SettingsPicker } from "@/features/settings/components/settings-controls";
import { useMobileWorkspaceActions } from "@/features/workspace/context/mobile-workspace-context";
import { SheetSaveAction } from "@/shared/components/sheet-save-action";
import { useText } from "@/shared/lib/text";

/** An imported agent gets no destination defaults until the admin reviews this mapping. */
export function TransferMapping({
  serverId,
  selection,
  options,
  importing,
  failure,
  onApply,
  onBack,
  onReload,
}: {
  serverId: string;
  selection: AgentAccessPolicyTransferSelection;
  options: AgentAccessPolicyTransferOptions;
  importing: boolean;
  failure: string | null;
  onApply: (input: AgentAccessPolicyTransferMapping) => void;
  onBack: () => void;
  onReload: () => void;
}) {
  const { t, format, errorMessage } = useText();
  const { theme } = useUniwind();
  const { previewTransferMapping } = useMobileWorkspaceActions();

  const [agents, setAgents] = useState<Record<string, string | null>>({});
  const [connections, setConnections] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{
    input: AgentAccessPolicyTransferMapping;
    result: AgentAccessPolicyTransferPreview;
  }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const locked = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = pending || importing;
  const complete =
    options.agents.every(({ key }) => Object.hasOwn(agents, key)) &&
    options.sourceConnections.every(({ id }) => Boolean(connections[id])) &&
    new Set(Object.values(connections)).size === options.sourceConnections.length;

  const name = (connection: AgentAccessPolicyTransferOptions["destinationConnections"][number]) =>
    connection.accountLabel
      ? t("mobile.server.agentGroups.connectionLabel", { name: connection.name, account: connection.accountLabel })
      : connection.name;
  const names = (ids: readonly string[]) =>
    format.list(
      ids.map((id) => {
        const connection = options.destinationConnections.find((entry) => entry.id === id);
        return connection ? name(connection) : id;
      }),
    );

  async function preview() {
    if (!complete || locked.current) return;

    locked.current = true;
    setPending(true);
    setError(undefined);

    const input: AgentAccessPolicyTransferMapping = {
      ...selection,
      expectedRevision: options.revision,
      agentMappings: options.agents.map(({ key }) => ({ key, policyId: agents[key] ?? null })),
      connectionMappings: options.sourceConnections.map(({ id }) => ({
        sourceId: id,
        destinationId: connections[id] ?? "",
      })),
    };

    try {
      const result = await previewTransferMapping(input, serverId);
      if (mounted.current) setReview({ input, result });
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught, t("mobile.server.transfer.importFailed")));
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <SettingsContent>
      <SheetSaveAction
        dirty
        canSave={complete && !busy}
        pending={busy}
        label={review ? t("mobile.server.transferMapping.import") : t("mobile.server.transferMapping.review")}
        pendingLabel={t("mobile.server.transfer.importing")}
        onSave={() => {
          if (review) onApply(review.input);
          else void preview();
        }}
      />
      <SettingsNote>{t("mobile.server.transferMapping.description")}</SettingsNote>
      {error || failure ? (
        <SettingsSection footer={error ?? failure ?? undefined}>
          <SettingsRow disclosure={false} disabled={busy} onPress={onReload}>
            <Typography.Paragraph className="text-accent">{t("common.retry")}</Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ) : null}
      {review ? (
        <SettingsSection title={t("mobile.server.transferMapping.review")}>
          {review.result.agents.map((agent) => (
            <SettingsRow
              key={agent.key}
              disclosure={false}
              supportingText={[
                agent.enabledConnectionIds.length > 0
                  ? t("mobile.server.agentGroups.enabled", { names: names(agent.enabledConnectionIds) })
                  : "",
                agent.disabledConnectionIds.length > 0
                  ? t("mobile.server.agentGroups.disabled", { names: names(agent.disabledConnectionIds) })
                  : "",
                t(
                  agent.allowNewConnections
                    ? "mobile.server.agentGroups.newConnectionsOn"
                    : "mobile.server.agentGroups.newConnectionsOff",
                ),
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <Typography.Paragraph>
                {options.agents.find(({ key }) => key === agent.key)?.name ?? agent.key}
              </Typography.Paragraph>
            </SettingsRow>
          ))}
          <SettingsRow disclosure={false} disabled={busy} onPress={() => setReview(undefined)}>
            <Typography.Paragraph className="text-accent">
              {t("mobile.server.transferMapping.edit")}
            </Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title={t("mobile.server.transferMapping.agents")}>
            {options.agents.map((agent) => {
              const selected = agents[agent.key];
              const source = options.sourcePolicies.find(({ id }) => id === agent.sourcePolicyId);

              return (
                <SettingsRow
                  key={agent.key}
                  disclosure={false}
                  supportingText={source?.name ?? t("mobile.server.agentGroups.noGroup")}
                  trailing={
                    <SettingsPicker
                      value={selected === undefined ? "" : selected === null ? "none" : `policy:${selected}`}
                      options={[
                        { value: "", label: t("mobile.server.transferMapping.choose") },
                        { value: "none", label: t("mobile.server.agentGroups.noGroup") },
                        ...options.destinationPolicies.map(({ id, name }) => ({ value: `policy:${id}`, label: name })),
                      ]}
                      enabled={!busy}
                      dark={theme === "dark"}
                      label={agent.name}
                      onChange={(value) => {
                        if (value)
                          setAgents((current) => ({
                            ...current,
                            [agent.key]: value === "none" ? null : value.slice(7),
                          }));
                      }}
                    />
                  }
                >
                  <Typography.Paragraph>{agent.name}</Typography.Paragraph>
                </SettingsRow>
              );
            })}
          </SettingsSection>
          <SettingsSection title={t("mobile.server.transferMapping.connections")}>
            {options.sourceConnections.map((source) => (
              <SettingsRow
                key={source.id}
                disclosure={false}
                trailing={
                  <SettingsPicker
                    value={connections[source.id] ?? ""}
                    options={[
                      { value: "", label: t("mobile.server.transferMapping.choose") },
                      ...options.destinationConnections
                        .filter(({ id }) => id === connections[source.id] || !Object.values(connections).includes(id))
                        .map((entry) => ({ value: entry.id, label: name(entry) })),
                    ]}
                    enabled={!busy}
                    dark={theme === "dark"}
                    label={source.name}
                    onChange={(value) => setConnections((current) => ({ ...current, [source.id]: value }))}
                  />
                }
              >
                <Typography.Paragraph>{source.name}</Typography.Paragraph>
              </SettingsRow>
            ))}
          </SettingsSection>
        </>
      )}
      <SettingsSection>
        <SettingsRow disclosure={false} disabled={busy} onPress={onBack}>
          <Typography.Paragraph className="text-accent">{t("common.cancel")}</Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
    </SettingsContent>
  );
}
