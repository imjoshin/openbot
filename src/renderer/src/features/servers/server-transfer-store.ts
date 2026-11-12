import type {
  InstanceTransferPreview,
  InstanceTransferResult,
  InstanceTransferSummary,
  OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { toast } from "@openbot/ui";
import type {
  InstanceExportOptions,
  InstanceExportPhase,
  InstanceImportPhase,
  InstanceTransferScreen,
} from "@openbot/ui/features/transfer/InstanceTransferView";
import { currentText } from "@openbot/ui/text";
import { createEffect, createStore, onCleanup, snapshot } from "solid-js";
import { desktopAnalytics } from "../../analytics";

/**
 * The transfer calls of one server. On the desktop, main routes them to this computer or to a joined
 * host. In the browser client they go to the connected host, and a download has no folder to show.
 */
export type ServerTransferCalls = Omit<OpenBotDesktopApi["instanceTransfer"], "showExport"> &
  Partial<Pick<OpenBotDesktopApi["instanceTransfer"], "showExport">>;

export interface ServerTransferMappingCalls {
  getTransferMapping(
    input: AgentAccessPolicyTransferSelection,
    serverId: string,
  ): Promise<AgentAccessPolicyTransferOptions | null>;
  previewTransferMapping(
    input: AgentAccessPolicyTransferMapping,
    serverId: string,
  ): Promise<AgentAccessPolicyTransferPreview>;
  applyTransferMapping(input: AgentAccessPolicyTransferMapping, serverId: string): Promise<InstanceTransferResult>;
}

interface TransferMappingState {
  selection: AgentAccessPolicyTransferSelection;
  options: AgentAccessPolicyTransferOptions;
  review?: { input: AgentAccessPolicyTransferMapping; preview: AgentAccessPolicyTransferPreview };
}

interface ServerTransferState {
  screen: InstanceTransferScreen;
  summary: InstanceTransferSummary | null;
  exportPhase: InstanceExportPhase;
  exportFileName: string | null;
  exportWarnings: string[];
  exportError: string | null;
  importPhase: InstanceImportPhase;
  preview: InstanceTransferPreview | null;
  result: InstanceTransferResult | null;
  importError: string | null;
  mapping: TransferMappingState | null;
}

const INITIAL: ServerTransferState = {
  screen: "home",
  summary: null,
  exportPhase: "options",
  exportFileName: null,
  exportWarnings: [],
  exportError: null,
  importPhase: "idle",
  preview: null,
  result: null,
  importError: null,
  mapping: null,
};

/** The Transfer section's view of one export and one import of one server. */
export function createServerTransferStore(
  serverId: string,
  calls: ServerTransferCalls,
  mappingCalls: () => ServerTransferMappingCalls | undefined,
) {
  const [state, setState] = createStore<ServerTransferState>({ ...INITIAL });
  let importGeneration = 0;
  onCleanup(() => {
    importGeneration += 1;
  });

  // The agents are read again each time the export screen opens.
  createEffect(
    () => state.screen === "export" && state.exportPhase === "options",
    (load) => {
      if (!load) return;
      void calls
        .summary(serverId)
        .then((summary) =>
          setState((draft) => {
            draft.summary = summary;
          }),
        )
        .catch((error: unknown) =>
          setState((draft) => {
            draft.exportError = message(error, "settings.transfer.export.failed");
          }),
        );
    },
  );

  function setScreen(screen: InstanceTransferScreen): void {
    setState((draft) => {
      draft.screen = screen;
      draft.exportError = null;
      draft.importError = null;
    });
  }

  function exportFile(options: InstanceExportOptions): void {
    setState((draft) => {
      draft.exportPhase = "exporting";
      draft.exportError = null;
    });
    void calls
      .export(options, serverId)
      .then((result) => {
        // A closed save dialog saves nothing.
        desktopAnalytics.track("server_transfer_action", {
          action: "export",
          result: result.saved ? "succeeded" : "cancelled",
        });
        setState((draft) => {
          draft.exportPhase = result.saved ? "saved" : "options";
          draft.exportFileName = result.fileName;
          draft.exportWarnings = result.warnings;
        });
      })
      .catch((error: unknown) => {
        desktopAnalytics.track("server_transfer_action", {
          action: "export",
          result: "failed",
          failure_code: "export_failed",
        });
        setState((draft) => {
          draft.exportPhase = "options";
          draft.exportError = message(error, "settings.transfer.export.failed");
        });
      });
  }

  // Absent when the calls have no folder to show.
  const show = calls.showExport;
  const showExport = show
    ? (): void => {
        void show().catch(report);
      }
    : undefined;

  function exportAgain(): void {
    setState((draft) => {
      draft.exportPhase = "options";
      draft.exportFileName = null;
      draft.exportWarnings = [];
    });
  }

  function choose(): void {
    setState((draft) => {
      draft.importPhase = "reading";
      draft.importError = null;
    });
    void calls
      .choose(serverId)
      .then((preview) =>
        setState((draft) => {
          // A closed dialog keeps the file that was open before.
          if (preview) draft.preview = preview;
          draft.importPhase = draft.preview ? "review" : "idle";
        }),
      )
      .catch((error: unknown) =>
        setState((draft) => {
          draft.importPhase = draft.preview ? "review" : "idle";
          draft.importError = message(error, "settings.transfer.import.openFailed");
        }),
      );
  }

  async function importFile(keys: string[], includeSettings: boolean): Promise<void> {
    const token = state.preview?.token;
    if (!token || state.importPhase === "importing") return;

    const generation = ++importGeneration;
    setState((draft) => {
      draft.importPhase = "importing";
      draft.importError = null;
    });

    const mappingApi = mappingCalls();
    if (!includeSettings && mappingApi && keys.length > 0) {
      const selection = { token, keys };
      try {
        const options = await mappingApi.getTransferMapping(selection, serverId);
        if (generation !== importGeneration) return;
        if (options) {
          setState((draft) => {
            draft.mapping = { selection, options };
            draft.importPhase = "review";
          });
          return;
        }
      } catch (error) {
        if (generation !== importGeneration) return;
        showMappingError(error);
        return;
      }
    }

    await applyImport(() => calls.apply({ token, keys, includeSettings }, serverId), generation);
  }

  function showMappingError(error: unknown) {
    setState((draft) => {
      draft.importPhase = "review";
      draft.importError = message(error, "settings.transfer.import.failed");
    });
  }

  async function refreshMapping(
    api: ServerTransferMappingCalls,
    selection: AgentAccessPolicyTransferSelection,
    generation: number,
    error: unknown,
  ) {
    setState((draft) => {
      if (draft.mapping) delete draft.mapping.review;
    });

    try {
      const options = await api.getTransferMapping(selection, serverId);
      if (generation !== importGeneration) return;

      setState((draft) => {
        draft.mapping = options ? { selection, options } : null;
      });
      showMappingError(error);
    } catch (readError) {
      if (generation !== importGeneration) return;
      showMappingError(readError);
    }
  }

  function stale(error: unknown) {
    return error instanceof Error && error.message.includes(sourceText("error.agentAccessPolicy.stale"));
  }

  async function previewMapping(input: AgentAccessPolicyTransferMapping): Promise<void> {
    const api = mappingCalls();
    const mapping = state.mapping;
    if (!api || !mapping || state.importPhase === "importing") return;

    const selection = snapshot(mapping.selection);
    const generation = ++importGeneration;
    setState((draft) => {
      draft.importPhase = "importing";
      draft.importError = null;
    });

    try {
      const mutation = snapshot(input);
      const preview = await api.previewTransferMapping(mutation, serverId);
      if (generation !== importGeneration) return;

      setState((draft) => {
        if (draft.mapping) draft.mapping.review = { input: mutation, preview };
        draft.importPhase = "review";
      });
    } catch (error) {
      if (generation !== importGeneration) return;

      if (stale(error)) await refreshMapping(api, selection, generation, error);
      else showMappingError(error);
    }
  }

  async function applyMapping(): Promise<void> {
    const api = mappingCalls();
    const mapping = state.mapping;
    if (!api || !mapping?.review || state.importPhase === "importing") return;

    const selection = snapshot(mapping.selection);
    const input = snapshot(mapping.review.input);
    const generation = ++importGeneration;
    setState((draft) => {
      draft.importPhase = "importing";
      draft.importError = null;
    });

    await applyImport(
      () => api.applyTransferMapping(input, serverId),
      generation,
      (error) => refreshMapping(api, selection, generation, error),
    );
  }

  async function applyImport(
    run: () => Promise<InstanceTransferResult>,
    generation: number,
    onStale?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    try {
      const result = await run();
      if (generation !== importGeneration) return;

      desktopAnalytics.track("server_transfer_action", { action: "import", result: "succeeded" });
      setState((draft) => {
        draft.importPhase = "done";
        draft.mapping = null;
        draft.preview = null;
        draft.result = result;
      });
    } catch (error) {
      if (generation !== importGeneration) return;
      if (onStale && stale(error)) {
        await onStale(error);
        return;
      }

      desktopAnalytics.track("server_transfer_action", {
        action: "import",
        result: "failed",
        failure_code: "import_failed",
      });
      setState((draft) => {
        draft.importPhase = "idle";
        draft.mapping = null;
        draft.preview = null;
        draft.importError = message(error, "settings.transfer.import.failed");
      });
    }
  }

  function editMapping(): void {
    setState((draft) => {
      if (draft.mapping) delete draft.mapping.review;
      draft.importError = null;
    });
  }

  function closeMapping(): void {
    setState((draft) => {
      draft.mapping = null;
      draft.importError = null;
    });
  }

  function cancelImport(): void {
    importGeneration += 1;
    const token = state.preview?.token;
    if (token) void calls.discard(token, serverId).catch(report);
    setState((draft) => {
      draft.importPhase = "idle";
      draft.preview = null;
      draft.mapping = null;
      draft.importError = null;
    });
  }

  function importDone(): void {
    setState((draft) => {
      draft.importPhase = "idle";
      draft.result = null;
      draft.screen = "home";
    });
  }

  return {
    state,
    setScreen,
    exportFile,
    showExport,
    exportAgain,
    choose,
    importFile,
    previewMapping,
    applyMapping,
    editMapping,
    closeMapping,
    cancelImport,
    importDone,
  };
}

function message(
  error: unknown,
  fallback:
    | "settings.transfer.export.failed"
    | "settings.transfer.import.openFailed"
    | "settings.transfer.import.failed",
): string {
  const { t, errorMessage } = currentText();
  return errorMessage(error, t(fallback));
}

function report(error: unknown): void {
  const { t, errorMessage } = currentText();
  toast.error(errorMessage(error, t("settings.transfer.import.failed")), {
    report: { operation: "settings", source: "system", cause_code: "unknown" },
  });
}

import type {
  AgentAccessPolicyTransferMapping,
  AgentAccessPolicyTransferOptions,
  AgentAccessPolicyTransferPreview,
  AgentAccessPolicyTransferSelection,
} from "@openbot/contracts/agent-access-policy-transfer";
