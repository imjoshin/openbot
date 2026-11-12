import type { AgentAccessPolicyConnection, AgentAccessPolicySnapshot } from "@openbot/contracts/agent-access-policy";
import { Button, Typography } from "heroui-native";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useCSSVariable, useUniwind } from "uniwind";
import type { AgentAccessPolicyView } from "@/features/servers/model/use-agent-access-policies";
import { SettingsNote, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { SettingsPicker, SettingsSwitch } from "@/features/settings/components/settings-controls";
import { useText } from "@/shared/lib/text";

export function AgentGroupPickerRow({
  policies,
  value,
  label,
  disabled,
  onChange,
}: {
  policies: AgentAccessPolicySnapshot["policies"];
  value: string | null | undefined;
  label?: string;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const { t } = useText();
  const { theme } = useUniwind();
  const title = label ?? t("mobile.server.agentGroups.group");

  return (
    <SettingsRow
      disclosure={false}
      trailing={
        <SettingsPicker
          value={value === undefined ? "choose" : value === null ? "none" : `policy:${value}`}
          options={[
            ...(value === undefined
              ? [{ value: "choose", label: t("mobile.server.agentGroups.chooseDestination") }]
              : []),
            { value: "none", label: t("mobile.server.agentGroups.noGroup") },
            ...policies.map((policy) => ({ value: `policy:${policy.id}`, label: policy.name })),
          ]}
          enabled={!disabled}
          dark={theme === "dark"}
          label={title}
          onChange={(id) => {
            if (id !== "choose") onChange(id === "none" ? null : id.slice("policy:".length));
          }}
        />
      }
    >
      <Typography.Paragraph>{title}</Typography.Paragraph>
    </SettingsRow>
  );
}

export function AgentPolicyToggle({
  title,
  value,
  disabled,
  details,
  warning,
  action,
  onChange,
}: {
  title: string;
  value: boolean;
  disabled: boolean;
  details?: string | undefined;
  warning?: boolean | undefined;
  action?: { label: string; run: () => void } | undefined;
  onChange: (value: boolean) => void;
}) {
  const { theme } = useUniwind();
  const warningColor = String(useCSSVariable("--openbot-warning-text"));

  return (
    <View>
      <SettingsRow disclosure={false}>
        <SettingsSwitch
          label={title}
          value={value}
          disabled={disabled}
          dark={theme === "dark"}
          onValueChange={onChange}
        />
      </SettingsRow>
      {details ? (
        <View className="flex-row items-center gap-2 px-4 pb-3">
          {warning ? <TriangleAlert color={warningColor} size={15} accessible={false} /> : null}
          <Typography.Paragraph type="body-xs" className="flex-1 text-grouped-secondary">
            {details}
          </Typography.Paragraph>
        </View>
      ) : null}
      {action ? (
        <SettingsRow disclosure={false} disabled={disabled} onPress={action.run}>
          <Typography.Paragraph className="text-accent">{action.label}</Typography.Paragraph>
        </SettingsRow>
      ) : null}
    </View>
  );
}

export function AgentPolicyStatus({ policy }: { policy: AgentAccessPolicyView }) {
  const { t } = useText();
  if (!policy.available) return <SettingsNote>{t("mobile.server.agentGroups.unsupported")}</SettingsNote>;

  return (
    <>
      {policy.error ? (
        <SettingsSection footer={policy.error}>
          <SettingsRow disabled={policy.busy} disclosure={false} onPress={policy.reload}>
            <Typography.Paragraph className="text-accent">{t("common.retry")}</Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ) : null}
      {policy.notice ? <SettingsNote>{policy.notice}</SettingsNote> : null}
      {!policy.data && policy.busy ? <SettingsNote>{t("mobile.server.agentGroups.loading")}</SettingsNote> : null}
    </>
  );
}

export function useAgentPolicyConnectionText() {
  const { t } = useText();
  return (connection: AgentAccessPolicyConnection) => {
    const name = connection.accountLabel
      ? t("mobile.server.agentGroups.connectionLabel", { name: connection.name, account: connection.accountLabel })
      : connection.name;
    return { name, availability: connection.available ? undefined : t("mobile.server.agentGroups.unavailable") };
  };
}

export function AgentPolicyReview({
  policy,
  children,
  onSaved,
}: {
  policy: AgentAccessPolicyView;
  children?: ReactNode;
  onSaved?: () => void;
}) {
  const { t, format } = useText();
  const connectionText = useAgentPolicyConnectionText();
  if (!policy.review || !policy.data) return null;

  const { mutation, preview } = policy.review;
  const { connections, agents } = policy.data;

  function names(ids: readonly string[]) {
    return format.list(
      ids.map((id) => {
        const connection = connections.find((item) => item.id === id);
        if (!connection) return id;

        const { name } = connectionText(connection);
        return connection.available ? name : t("mobile.server.agentGroups.unavailableLabel", { name });
      }),
    );
  }

  return (
    <>
      <SettingsSection
        title={t("mobile.server.agentGroups.preview")}
        footer={format.list([
          t("mobile.server.agentGroups.removed", { count: preview.overridesRemoved }),
          t("mobile.server.agentGroups.retained", { count: preview.overridesRetained }),
        ])}
      >
        {preview.changes.length === 0 ? (
          <SettingsRow disclosure={false}>
            <Typography.Paragraph>{t("mobile.server.agentGroups.noChanges")}</Typography.Paragraph>
          </SettingsRow>
        ) : (
          preview.changes.map((change) => {
            const details = [
              ...(change.enabledConnectionIds.length
                ? [t("mobile.server.agentGroups.enabled", { names: names(change.enabledConnectionIds) })]
                : []),
              ...(change.disabledConnectionIds.length
                ? [t("mobile.server.agentGroups.disabled", { names: names(change.disabledConnectionIds) })]
                : []),
            ];

            return (
              <SettingsRow
                key={change.agentId}
                disclosure={false}
                supportingText={[
                  ...(details.length ? details : [t("mobile.server.agentGroups.noChanges")]),
                  format.list([
                    t("mobile.server.agentGroups.removed", { count: change.overridesRemoved }),
                    t("mobile.server.agentGroups.retained", { count: change.overridesRetained }),
                  ]),
                ].join("\n")}
              >
                <Typography.Paragraph>
                  {agents.find((agent) => agent.id === change.agentId)?.name ?? change.agentId}
                </Typography.Paragraph>
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
      {children}
      <View className="gap-2">
        <Button
          isDisabled={policy.busy}
          variant={mutation.kind === "deletePolicy" ? "danger" : "primary"}
          onPress={() =>
            void policy.confirm().then((saved) => {
              if (saved === "saved") onSaved?.();
            })
          }
        >
          <Button.Label>
            {t(
              mutation.kind === "deletePolicy"
                ? "mobile.server.agentGroups.delete"
                : "mobile.server.agentGroups.confirm",
            )}
          </Button.Label>
        </Button>
        <Button isDisabled={policy.busy} variant="secondary" onPress={policy.cancel}>
          <Button.Label>{t("common.cancel")}</Button.Label>
        </Button>
      </View>
    </>
  );
}
