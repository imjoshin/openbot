import type { AgentProviderId } from "@openbot/contracts/agent-providers";
import { AgentAccessPolicyTransferView } from "@openbot/ui/features/transfer/AgentAccessPolicyTransferView";
import { InstanceTransferView } from "@openbot/ui/features/transfer/InstanceTransferView";
import { Show } from "solid-js";
import {
  createServerTransferStore,
  type ServerTransferCalls,
  type ServerTransferMappingCalls,
} from "./server-transfer-store";

export interface ServerTransferOptions {
  /** Signs in to a provider of this computer. Absent for a joined server, whose providers are its own. */
  onSignIn?: ((provider: AgentProviderId) => void) | undefined;
  /** The server can put the chat history in the file. */
  history?: boolean;
  calls?: ServerTransferCalls;
  policyMapping?: ServerTransferMappingCalls | undefined;
}

/** Server settings > Transfer: the shared view, for one server. */
export function ServerTransferPanel(props: ServerTransferOptions & { serverId: string }) {
  const store = createServerTransferStore(
    props.serverId,
    props.calls ?? window.openbot.instanceTransfer,
    () => props.policyMapping,
  );

  return (
    <InstanceTransferView
      screen={store.state.screen}
      onScreenChange={(screen) => store.setScreen(screen)}
      summary={store.state.summary}
      exportPhase={store.state.exportPhase}
      exportFileName={store.state.exportFileName}
      exportWarnings={store.state.exportWarnings}
      exportError={store.state.exportError}
      onExport={(options) => store.exportFile(options)}
      historyAvailable={props.history}
      onShowExport={store.showExport}
      onExportAgain={() => store.exportAgain()}
      importPhase={store.state.importPhase}
      preview={store.state.preview}
      result={store.state.result}
      importError={store.state.importError}
      mappingActive={Boolean(store.state.mapping)}
      mapping={
        <Show when={store.state.mapping}>
          {(mapping) => (
            <Show when={`${mapping().selection.token}:${mapping().options.revision}`} keyed>
              {(_mappingKey) => (
                <AgentAccessPolicyTransferView
                  selection={mapping().selection}
                  options={mapping().options}
                  preview={mapping().review?.preview}
                  error={store.state.importError}
                  busy={store.state.importPhase === "importing"}
                  onPreview={(input) => void store.previewMapping(input)}
                  onImport={() => void store.applyMapping()}
                  onEdit={store.editMapping}
                  onBack={store.closeMapping}
                />
              )}
            </Show>
          )}
        </Show>
      }
      onChoose={() => store.choose()}
      onImport={(keys, includeSettings) => void store.importFile(keys, includeSettings)}
      onCancelImport={() => store.cancelImport()}
      onImportDone={() => store.importDone()}
      onSignIn={props.onSignIn}
    />
  );
}
