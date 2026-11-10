import type { AgentPlugin, SetAgentPluginInput } from "@openbot/contracts/ipc";
import { Button, Switch, Text } from "@openbot/ui";
import { SettingsLinkGroup } from "@openbot/ui/components/SettingsPanel";
import { createEffect, createStore, For, Show } from "solid-js";
import { useText } from "../../text";

export interface AgentPluginCalls {
  read(agentId: string): Promise<AgentPlugin[]>;
  set(input: SetAgentPluginInput): Promise<AgentPlugin[]>;
}

export function AgentPlugins(props: { agentId: string; api: AgentPluginCalls }) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{ rows: AgentPlugin[]; busy: boolean; loaded: boolean; error: string | null }>({
    rows: [],
    busy: true,
    loaded: false,
    error: null,
  });
  let generation = 0;
  let reload: (() => void) | undefined;
  createEffect(
    () => [props.agentId, props.api] as const,
    ([agentId, api]) => {
      const current = ++generation;
      const read = async () => {
        setState((s) => {
          s.busy = true;
          s.error = null;
        });
        try {
          const rows = await api.read(agentId);
          if (generation === current)
            setState((s) => {
              s.rows = rows;
              s.loaded = true;
            });
        } catch (error) {
          if (generation === current)
            setState((s) => {
              s.error = errorMessage(error, t("agentSettings.plugins.readFailed"));
            });
        } finally {
          if (generation === current)
            setState((s) => {
              s.busy = false;
            });
        }
      };
      setState(() => ({ rows: [], busy: true, loaded: false, error: null }));
      reload = () => void read();
      void read();
      return () => {
        generation++;
        reload = undefined;
      };
    },
  );
  async function change(pluginId: string, enabled: boolean) {
    if (state.busy) return;
    const current = generation;
    setState((s) => {
      s.busy = true;
      s.error = null;
    });
    try {
      const rows = await props.api.set({ agentId: props.agentId, pluginId, enabled });
      if (generation === current)
        setState((s) => {
          s.rows = rows;
        });
    } catch (error) {
      if (generation === current)
        setState((s) => {
          s.error = errorMessage(error, t("agentSettings.plugins.saveFailed"));
        });
    } finally {
      if (generation === current)
        setState((s) => {
          s.busy = false;
        });
    }
  }
  return (
    <div class="agent-settings-page" aria-busy={state.busy ? "true" : "false"}>
      <Show when={state.error}>
        {(error) => (
          <div class="agent-session-setting-notes">
            <Text role="alert">{error()}</Text>
            <Button variant="outline" size="sm" disabled={state.busy} onClick={() => reload?.()}>
              {t("common.retry")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={state.loaded && state.rows.length === 0}>
        <Text as="p" class="agent-settings-runtime-note" tone="muted">
          {t("agentSettings.plugins.empty")}
        </Text>
      </Show>
      <SettingsLinkGroup inset class="agent-settings-runtime-rows" title={t("agentSettings.plugins.title")}>
        <For each={state.rows}>
          {(plugin) => (
            <div class="agent-session-setting">
              <div class="agent-settings-switch-row">
                <span class="settings-link-label">{plugin.name}</span>
                <Switch
                  size="sm"
                  aria-label={plugin.name}
                  checked={plugin.enabled}
                  disabled={state.busy}
                  onChange={(enabled) => void change(plugin.id, enabled)}
                />
              </div>
              <Show when={!plugin.available}>
                <div class="agent-session-setting-notes">
                  <Text tone="muted">{t("agentSettings.plugins.unavailable")}</Text>
                </div>
              </Show>
            </div>
          )}
        </For>
      </SettingsLinkGroup>
      <Text as="p" class="agent-settings-runtime-note" variant="caption" tone="muted">
        {t("agentSettings.plugins.description")}
      </Text>
    </div>
  );
}
