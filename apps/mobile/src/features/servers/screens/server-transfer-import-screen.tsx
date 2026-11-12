import type {
  AgentAccessPolicyTransferMapping,
  AgentAccessPolicyTransferOptions,
  AgentAccessPolicyTransferSelection,
} from "@openbot/contracts/agent-access-policy-transfer";
import { agentProviderName } from "@openbot/contracts/agent-providers";
import type { InstanceTransferPreview, RemoteInstanceTransferResult } from "@openbot/contracts/ipc";
import { INSTANCE_TRANSFER_REMOTE_BYTES } from "@openbot/contracts/team-protocol/instance-transfer-v1";
import { sourceText } from "@openbot/i18n/source";
import { useLocalSearchParams } from "expo-router";
import { Typography } from "heroui-native";
import { useLayoutEffect, useRef, useState } from "react";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import {
  agentContents,
  exportDate,
  IncludeRow,
  NotesSection,
  toggledKeys,
  transferContents,
} from "@/features/servers/components/import-parts";
import { TransferMapping } from "@/features/servers/components/transfer-mapping";
import { pickZipUpload } from "@/features/servers/model/transfer-file";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import {
  useMobileWorkspaceActions,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { SheetSaveAction } from "@/shared/components/sheet-save-action";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

type Phase = "idle" | "reading" | "review" | "mapping" | "importing" | "done";

/** Replaces the native header action after the review screen unmounts. */
function ClearedImportAction() {
  return <SheetSaveAction dirty={false} canSave={false} pending={false} onSave={() => undefined} />;
}

/**
 * Server settings › Transfer › Import. The chosen transfer file goes to the host, which keeps it under a
 * token: the review shows what is in it before anything changes. A token left open when the page
 * closes is released.
 */
export function ServerTransferImportScreen() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const scope = useQueryScope();
  const canTransfer = useMobileWorkspaceSelector((workspace) => workspace.canTransferServer(serverId));
  const canMap = useMobileWorkspaceSelector((workspace) => workspace.canManageAgentAccessPolicy(serverId));
  return (
    <ServerTransferImport
      key={JSON.stringify([scope, serverId, canTransfer, canMap])}
      serverId={serverId}
      canTransfer={canTransfer}
      canMap={canMap}
    />
  );
}

function ServerTransferImport({
  serverId,
  canTransfer,
  canMap,
}: {
  serverId: string;
  canTransfer: boolean;
  canMap: boolean;
}) {
  const { t, errorMessage } = useText();
  const {
    stageInstanceTransfer,
    applyInstanceTransfer,
    discardInstanceTransfer,
    getTransferMapping,
    applyTransferMapping,
  } = useMobileWorkspaceActions();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<InstanceTransferPreview | null>(null);
  const [result, setResult] = useState<RemoteInstanceTransferResult | null>(null);
  const [mapping, setMapping] = useState<{
    selection: AgentAccessPolicyTransferSelection;
    options: AgentAccessPolicyTransferOptions;
    generation: number;
  }>();
  const locked = useRef(false);

  // The open token, for the release when the page closes. A token that comes back after that is
  // released when it arrives.
  const token = useRef<string | null>(null);
  const closed = useRef(false);
  useLayoutEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (token.current) void discardInstanceTransfer(token.current, serverId).catch(() => undefined);
    };
  }, [discardInstanceTransfer, serverId]);

  if (!canTransfer)
    return (
      <SettingsContent>
        <ClearedImportAction />
        <SettingsNote>{t("mobile.server.transfer.unavailable")}</SettingsNote>
      </SettingsContent>
    );

  async function choose() {
    const open = preview;
    setPhase("reading");
    setError(null);
    setProgress(null);
    try {
      const upload = await pickZipUpload(
        INSTANCE_TRANSFER_REMOTE_BYTES,
        sourceText("error.import.transferRemoteTooLarge"),
      );
      if (closed.current) return;
      if (!upload) {
        setPhase(open ? "review" : "idle");
        return;
      }
      const next = await stageInstanceTransfer(upload, serverId, (fraction) => {
        if (!closed.current) setProgress(Math.floor(fraction * 100));
      });
      if (open) void discardInstanceTransfer(open.token, serverId).catch(() => undefined);
      if (closed.current) {
        void discardInstanceTransfer(next.token, serverId).catch(() => undefined);
        return;
      }
      token.current = next.token;
      setPreview(next);
      setPhase("review");
    } catch (caught) {
      if (closed.current) return;
      setPhase(open ? "review" : "idle");
      setError(errorMessage(caught, t("mobile.server.transfer.openFailed")));
      void haptics.notification("error");
    } finally {
      if (!closed.current) setProgress(null);
    }
  }

  async function apply(keys: string[], includeSettings: boolean) {
    if (!preview || locked.current) return;
    locked.current = true;
    setError(null);
    if (!includeSettings && keys.length > 0 && canMap) {
      setPhase("reading");
      try {
        const selection = { token: preview.token, keys };
        const options = await getTransferMapping(selection, serverId);
        if (closed.current) return;
        if (options) {
          setMapping((previous) => ({ selection, options, generation: (previous?.generation ?? 0) + 1 }));
          setPhase("mapping");
          return;
        }
      } catch (caught) {
        if (!closed.current) {
          setError(errorMessage(caught, t("mobile.server.transfer.importFailed")));
          setPhase("review");
        }
        return;
      } finally {
        locked.current = false;
      }
    }
    await finish(() => applyInstanceTransfer({ token: preview.token, keys, includeSettings }, serverId));
  }

  async function finish(
    operation: () => Promise<RemoteInstanceTransferResult>,
    selection?: AgentAccessPolicyTransferSelection,
  ) {
    locked.current = true;
    setPhase("importing");
    setError(null);
    try {
      const done = await operation();
      if (closed.current) return;
      token.current = null;
      setMapping(undefined);
      setPreview(null);
      setResult(done);
      setPhase("done");
      void haptics.notification("success");
    } catch (caught) {
      if (closed.current) return;
      if (
        selection &&
        caught instanceof Error &&
        caught.message.includes(sourceText("error.agentAccessPolicy.stale"))
      ) {
        try {
          const options = await getTransferMapping(selection, serverId);
          if (closed.current) return;
          if (options) {
            setMapping((previous) => ({ selection, options, generation: (previous?.generation ?? 0) + 1 }));
            setError(errorMessage(caught, t("mobile.server.transfer.importFailed")));
            setPhase("mapping");
            return;
          }
        } catch {
          // If the file is no longer staged, return to file selection below.
        }
      }
      // The token is spent once the host starts, so the file must be chosen again.
      token.current = null;
      setPreview(null);
      setMapping(undefined);
      setPhase("idle");
      setError(errorMessage(caught, t("mobile.server.transfer.importFailed")));
      void haptics.notification("error");
    } finally {
      locked.current = false;
    }
  }

  if (phase === "done" && result)
    return (
      <>
        <ClearedImportAction />
        <TransferResult result={result} />
      </>
    );

  if (mapping && (phase === "mapping" || phase === "importing"))
    return (
      <TransferMapping
        key={mapping.generation}
        serverId={serverId}
        selection={mapping.selection}
        options={mapping.options}
        importing={phase === "importing"}
        failure={error}
        onApply={(input: AgentAccessPolicyTransferMapping) => {
          if (!locked.current) void finish(() => applyTransferMapping(input, serverId), mapping.selection);
        }}
        onBack={() => {
          setMapping(undefined);
          setPhase("review");
        }}
        onReload={() => void apply([...mapping.selection.keys], false)}
      />
    );

  if (preview && phase !== "idle")
    return (
      <TransferReview
        key={preview.token}
        preview={preview}
        reading={phase === "reading"}
        importing={phase === "importing"}
        progress={progress}
        error={error}
        onChoose={() => void choose()}
        onImport={(keys, includeSettings) => void apply(keys, includeSettings)}
      />
    );

  return (
    <SettingsContent>
      <ClearedImportAction />
      <SettingsSection
        title={t("mobile.server.transfer.import")}
        footer={error ?? t("mobile.server.transfer.importLede")}
      >
        <SettingsRow disclosure={false} disabled={phase === "reading"} onPress={() => void choose()}>
          <Typography.Paragraph className="text-accent">
            {phase !== "reading"
              ? t("mobile.server.transfer.choose")
              : progress === null
                ? t("mobile.server.transfer.reading")
                : t("mobile.server.transfer.sending", { percent: progress })}
          </Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
    </SettingsContent>
  );
}

function TransferReview({
  preview,
  reading,
  importing,
  progress,
  error,
  onChoose,
  onImport,
}: {
  preview: InstanceTransferPreview;
  reading: boolean;
  importing: boolean;
  progress: number | null;
  error: string | null;
  onChoose: () => void;
  onImport: (keys: string[], includeSettings: boolean) => void;
}) {
  const { t, format } = useText();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [settings, setSettings] = useState(preview.hasSettings);
  const busy = reading || importing;
  const selected = preview.agents.filter((agent) => !excluded.has(agent.key));
  const fileBytes = selected.reduce((total, agent) => total + agent.fileBytes, 0);
  const source = preview.exportedAt
    ? t("mobile.server.transfer.source", {
        version: preview.appVersion,
        date: exportDate(preview.exportedAt, format),
      })
    : t("mobile.server.transfer.sourceNoDate", { version: preview.appVersion });
  const contents = transferContents(t, format, selected, fileBytes, settings).join(" · ");
  const label =
    selected.length > 0
      ? t("mobile.server.transfer.submit", { count: selected.length })
      : t("mobile.server.transfer.submitSettings");

  return (
    <SettingsContent>
      <SheetSaveAction
        dirty
        canSave={(selected.length > 0 || settings) && !reading}
        pending={importing}
        label={label}
        pendingLabel={t("mobile.server.transfer.importing")}
        onSave={() =>
          onImport(
            selected.map((agent) => agent.key),
            settings,
          )
        }
      />
      <SettingsSection title={t("mobile.server.transfer.contains")} footer={error ?? label}>
        <SettingsRow disclosure={false} supportingText={contents}>
          <Typography.Paragraph>{source}</Typography.Paragraph>
        </SettingsRow>
        <SettingsRow disclosure={false} disabled={busy} onPress={onChoose}>
          <Typography.Paragraph className="text-accent">
            {!reading
              ? t("mobile.server.transfer.chooseAnother")
              : progress === null
                ? t("mobile.server.transfer.reading")
                : t("mobile.server.transfer.sending", { percent: progress })}
          </Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
      <NotesSection title={t("mobile.server.transfer.importWarnings")} notes={preview.warnings} />
      {preview.agents.length > 0 ? (
        <SettingsSection title={t("mobile.server.transfer.importAgents")}>
          {preview.agents.map((agent) => (
            <IncludeRow
              key={agent.key}
              label={agent.name}
              supportingText={[
                agentContents(t, agent),
                ...(agent.fileBytes > 0 ? [format.fileSize(agent.fileBytes)] : []),
                ...(agent.nameExists ? [t("mobile.server.transfer.nameExists")] : []),
              ].join(" · ")}
              value={!excluded.has(agent.key)}
              disabled={busy}
              onValueChange={(include) => setExcluded(toggledKeys(excluded, agent.key, include))}
            />
          ))}
        </SettingsSection>
      ) : null}
      {preview.hasSettings ? (
        <SettingsSection footer={t("mobile.server.transfer.importSettingsNote")}>
          <IncludeRow
            label={t("mobile.server.transfer.importSettings")}
            value={settings}
            disabled={busy}
            onValueChange={setSettings}
          />
        </SettingsSection>
      ) : null}
    </SettingsContent>
  );
}

function TransferResult({ result }: { result: RemoteInstanceTransferResult }) {
  const { t, sourceText: localize } = useText();
  return (
    <SettingsContent>
      <SettingsSection
        title={t("mobile.server.transfer.imported", { count: result.agents.length })}
        footer={t("mobile.server.transfer.next")}
      >
        {result.agents.map((agent) => (
          <SettingsRow key={agent.agentId} disclosure={false}>
            <Typography.Paragraph>{agent.name}</Typography.Paragraph>
          </SettingsRow>
        ))}
      </SettingsSection>
      {result.signIn.length > 0 ? (
        <SettingsSection title={t("mobile.server.transfer.signIn")} footer={t("mobile.server.transfer.signInNote")}>
          {result.signIn.map((provider) => (
            <SettingsRow key={provider} disclosure={false}>
              <Typography.Paragraph>{agentProviderName(provider)}</Typography.Paragraph>
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}
      {result.skipped.length > 0 ? (
        <SettingsSection title={t("mobile.server.transfer.notImported")}>
          {result.skipped.map((entry) => (
            <SettingsRow key={entry.key} disclosure={false} supportingText={localize(entry.reason)}>
              <Typography.Paragraph>{entry.name}</Typography.Paragraph>
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}
      <NotesSection title={t("mobile.server.transfer.warnings")} notes={result.warnings} />
    </SettingsContent>
  );
}
