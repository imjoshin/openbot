import type {
  AgentAccessPolicyApplyResult,
  AgentAccessPolicyMutation,
  AgentAccessPolicyPreview,
  AgentAccessPolicySnapshot,
} from "@openbot/contracts/agent-access-policy";
import { Button, ConfirmDialog, Item, ItemContent, ItemDescription, ItemTitle, Text } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createStore, For, onCleanup, Show, snapshot, untrack } from "solid-js";
import { useText } from "../../text";

export interface AgentAccessPolicyCalls {
  serverId: string;
  list(): Promise<AgentAccessPolicySnapshot>;
  preview(input: AgentAccessPolicyMutation): Promise<AgentAccessPolicyPreview>;
  apply(input: AgentAccessPolicyMutation): Promise<AgentAccessPolicyApplyResult>;
}

type Review = { mutation: AgentAccessPolicyMutation; preview: AgentAccessPolicyPreview };
type LoadState = {
  data: AgentAccessPolicySnapshot | undefined;
  review: Review | undefined;
  busy: boolean;
  error: string | undefined;
  notice: string | undefined;
};

export function createAgentAccessPolicyResource(calls: () => AgentAccessPolicyCalls) {
  const { t, errorMessage, format } = useText();
  const [state, setState] = createStore<LoadState>({
    data: undefined,
    review: undefined,
    busy: false,
    error: undefined,
    notice: undefined,
  });
  let generation = 0;
  onCleanup(() => {
    generation += 1;
  });

  async function read(api: AgentAccessPolicyCalls, preserveError = false, clearData = false) {
    const request = ++generation;
    setState((draft) => {
      draft.busy = true;
      draft.review = undefined;
      if (!preserveError) draft.error = undefined;
      if (clearData) {
        draft.data = undefined;
        draft.notice = undefined;
      }
    });
    try {
      const data = await api.list();
      if (request !== generation) return;
      setState((draft) => {
        draft.data = data;
        draft.busy = false;
      });
    } catch (error) {
      if (request !== generation) return;
      setState((draft) => {
        draft.data = undefined;
        draft.busy = false;
        draft.error = errorMessage(error, t("server.agentGroups.loadFailed"));
      });
    }
  }

  // Host status updates can recreate the call object during a review. Authorization changes
  // remove this panel, and the server ID distinguishes reads that belong to a different host.
  const serverId = createMemo(() => calls().serverId);
  createEffect(
    () => {
      serverId();
      return untrack(calls);
    },
    (api) => void read(api, false, true),
  );

  async function preview(mutation: AgentAccessPolicyMutation, replace = false) {
    if (state.busy) return;
    const api = calls();
    const request = ++generation;
    setState((draft) => {
      draft.busy = true;
      if (!replace) draft.review = undefined;
      draft.error = undefined;
      draft.notice = undefined;
    });
    try {
      const preview = await api.preview(snapshot(mutation));
      if (request !== generation) return;
      setState((draft) => {
        draft.review = { mutation, preview };
        draft.busy = false;
      });
    } catch (error) {
      if (request !== generation) return;
      setState((draft) => {
        draft.error = errorMessage(error, t("server.agentGroups.saveFailed"));
      });
      await read(api, true);
    }
  }

  async function apply(onSaved?: (mutation: AgentAccessPolicyMutation) => void) {
    const review = state.review;
    if (!review || state.busy) return;
    const api = calls();
    const request = ++generation;
    setState((draft) => {
      draft.busy = true;
    });
    try {
      const mutation = snapshot(review.mutation);
      const result = await api.apply(mutation);
      if (request !== generation) return;
      setState((draft) => {
        draft.data = result.snapshot;
        draft.review = undefined;
        draft.busy = false;
        draft.notice =
          result.status === "refreshPending"
            ? t("server.agentGroups.refreshPending", {
                names: format.list(
                  result.snapshot.agents
                    .filter((agent) => result.agentIds.includes(agent.id))
                    .map((agent) => agent.name),
                ),
              })
            : undefined;
      });
      onSaved?.(mutation);
    } catch (error) {
      if (request !== generation) return;
      setState((draft) => {
        draft.error = errorMessage(error, t("server.agentGroups.saveFailed"));
      });
      await read(api, true);
    }
  }

  return {
    state,
    preview,
    apply,
    reload: () => read(calls()),
    cancel: () => {
      setState((draft) => {
        draft.review = undefined;
      });
    },
  };
}

export type AgentAccessPolicyResource = ReturnType<typeof createAgentAccessPolicyResource>;

export function AgentAccessPolicyStatus(props: { resource: AgentAccessPolicyResource }) {
  const { t } = useText();
  return (
    <>
      <Show when={!props.resource.state.data && props.resource.state.busy}>
        <Text tone="muted" variant="caption" role="status">
          {t("server.agentGroups.loading")}
        </Text>
      </Show>
      <Show when={props.resource.state.error}>
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>
              <Text tone="danger" variant="caption" role="alert">
                {props.resource.state.error}
              </Text>
            </ItemTitle>
          </ItemContent>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={props.resource.state.busy}
            onClick={() => void props.resource.reload()}
          >
            {t("common.retry")}
          </Button>
        </Item>
      </Show>
      <Show when={props.resource.state.notice}>
        <Text tone="muted" variant="caption" role="status">
          {props.resource.state.notice}
        </Text>
      </Show>
    </>
  );
}

export function AgentAccessPolicyReview(props: {
  resource: AgentAccessPolicyResource;
  onSaved?: (mutation: AgentAccessPolicyMutation) => void;
  children?: (review: Review) => JSX.Element;
}) {
  const { t, format } = useText();
  const names = (ids: readonly string[]) =>
    format.list(
      ids.map((id) => {
        const connection = props.resource.state.data?.connections.find((connection) => connection.id === id);
        if (!connection) return id;
        const label = connection.accountLabel
          ? t("server.agentGroups.connectionLabel", { name: connection.name, account: connection.accountLabel })
          : connection.name;
        return connection.available ? label : t("server.agentGroups.unavailableLabel", { name: label });
      }),
    );
  return (
    <ConfirmDialog
      open={Boolean(props.resource.state.review)}
      title={t("server.agentGroups.preview")}
      confirmLabel={
        props.resource.state.review?.mutation.kind === "deletePolicy"
          ? t("server.agentGroups.delete")
          : t("server.agentGroups.confirm")
      }
      tone={props.resource.state.review?.mutation.kind === "deletePolicy" ? "destructive" : "default"}
      initialFocus="cancel"
      pending={props.resource.state.busy}
      onCancel={props.resource.cancel}
      onConfirm={() => props.resource.apply(props.onSaved)}
    >
      <Show when={props.resource.state.review}>
        {(review) => (
          <>
            <Show when={review().preview.changes.length === 0}>
              <Text variant="caption" tone="muted">
                {t("server.agentGroups.noChanges")}
              </Text>
            </Show>
            <div class="agent-access-policy-review">
              <For each={review().preview.changes}>
                {(change) => (
                  <Item class="settings-modal-row">
                    <ItemContent>
                      <ItemTitle>
                        {props.resource.state.data?.agents.find((agent) => agent.id === change.agentId)?.name ??
                          change.agentId}
                      </ItemTitle>
                      <Show when={change.enabledConnectionIds.length > 0}>
                        <ItemDescription>
                          {t("server.agentGroups.enabled", { names: names(change.enabledConnectionIds) })}
                        </ItemDescription>
                      </Show>
                      <Show when={change.disabledConnectionIds.length > 0}>
                        <ItemDescription>
                          {t("server.agentGroups.disabled", { names: names(change.disabledConnectionIds) })}
                        </ItemDescription>
                      </Show>
                      <Show
                        when={change.enabledConnectionIds.length === 0 && change.disabledConnectionIds.length === 0}
                      >
                        <ItemDescription>{t("server.agentGroups.noChanges")}</ItemDescription>
                      </Show>
                      <ItemDescription>
                        {format.list([
                          t("server.agentGroups.removed", { count: change.overridesRemoved }),
                          t("server.agentGroups.retained", { count: change.overridesRetained }),
                        ])}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                )}
              </For>
            </div>
            <Text variant="caption" tone="muted" role="status">
              {format.list([
                t("server.agentGroups.removed", { count: review().preview.overridesRemoved }),
                t("server.agentGroups.retained", { count: review().preview.overridesRetained }),
              ])}
            </Text>
            {props.children?.(review())}
          </>
        )}
      </Show>
    </ConfirmDialog>
  );
}
