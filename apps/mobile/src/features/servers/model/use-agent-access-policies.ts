import type { AgentAccessPolicyMutation, AgentAccessPolicyPreview } from "@openbot/contracts/agent-access-policy";
import { sourceText } from "@openbot/i18n/source";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import {
  useMobileWorkspaceActions,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { queryKeys } from "@/features/workspace/model/query-keys";
import { useText } from "@/shared/lib/text";

type Review = { scope: symbol; mutation: AgentAccessPolicyMutation; preview: AgentAccessPolicyPreview };
type ScopedMutation = { scope: symbol; input: AgentAccessPolicyMutation };

export function useAgentAccessPolicies(serverId: string) {
  const { t, format, errorMessage } = useText();
  const available = useMobileWorkspaceSelector((workspace) => workspace.canManageAgentAccessPolicy(serverId));
  const { loadAgentAccessPolicies, previewAgentAccessPolicy, applyAgentAccessPolicy } = useMobileWorkspaceActions();
  const scope = useQueryScope();
  const client = useQueryClient();

  const key = queryKeys.agentAccessPolicies(scope, serverId);
  const scopeKey = JSON.stringify([...key, available]);
  const identity = useMemo(() => Symbol(scopeKey), [scopeKey]);
  const currentScope = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    currentScope.current = identity;
    return () => {
      currentScope.current = null;
    };
  }, [identity]);
  const isCurrent = () => currentScope.current === identity;

  const query = useQuery({
    queryKey: key,
    enabled: available,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: () => loadAgentAccessPolicies(serverId),
  });
  const [pendingReview, setReview] = useState<Review>();
  const review = pendingReview?.scope === identity ? pendingReview : undefined;
  const [notice, setNotice] = useState<{ scope: symbol; text: string }>();
  const locked = useRef<symbol | null>(null);

  const preview = useMutation({
    mutationFn: async ({ scope, input }: ScopedMutation) => {
      if (currentScope.current !== scope) throw new Error(sourceText("error.agent.accessPolicy.stale"));
      return previewAgentAccessPolicy(input, serverId);
    },
  });
  const apply = useMutation({
    mutationFn: async ({ scope, input }: ScopedMutation) => {
      if (currentScope.current !== scope) throw new Error(sourceText("error.agent.accessPolicy.stale"));
      return applyAgentAccessPolicy(input, serverId);
    },
  });

  async function requestPreview(mutation: AgentAccessPolicyMutation) {
    if (!available || !isCurrent() || locked.current === identity) return;

    locked.current = identity;
    apply.reset();

    try {
      const result = await preview.mutateAsync({ scope: identity, input: mutation });
      if (isCurrent()) setReview({ scope: identity, mutation, preview: result });
    } catch {
      if (isCurrent()) {
        setReview(undefined);
        await query.refetch();
      }
    } finally {
      if (locked.current === identity) locked.current = null;
    }
  }

  async function confirm() {
    if (!available || !isCurrent() || !review || locked.current === identity) return false;

    locked.current = identity;
    try {
      const result = await apply.mutateAsync({ scope: identity, input: review.mutation });
      if (!isCurrent()) return false;
      await client.cancelQueries({ queryKey: key, exact: true });
      if (!isCurrent()) return false;

      client.setQueryData(key, result.snapshot);
      setReview(undefined);
      setNotice(
        result.status === "refreshPending"
          ? {
              scope: identity,
              text: t("mobile.server.agentGroups.refreshPending", {
                names: format.list(
                  result.snapshot.agents
                    .filter((agent) => result.agentIds.includes(agent.id))
                    .map((agent) => agent.name),
                ),
              }),
            }
          : undefined,
      );
      return result.status;
    } catch {
      if (isCurrent()) {
        setReview(undefined);
        await query.refetch();
      }
      return false;
    } finally {
      if (locked.current === identity) locked.current = null;
    }
  }

  const loadError =
    available && query.error ? errorMessage(query.error, t("mobile.server.agentGroups.loadFailed")) : undefined;
  const currentPreview = preview.variables?.scope === identity ? preview : undefined;
  const currentApply = apply.variables?.scope === identity ? apply : undefined;
  const actionError = currentPreview?.error ?? currentApply?.error;

  return {
    available,
    data: available ? query.data : undefined,
    error: actionError ? errorMessage(actionError, t("mobile.server.agentGroups.saveFailed")) : loadError,
    busy: query.isFetching || Boolean(currentPreview?.isPending || currentApply?.isPending),
    notice: notice?.scope === identity ? notice.text : undefined,
    reload: () => {
      if (!available || !isCurrent()) return;

      preview.reset();
      apply.reset();
      void query.refetch();
    },
    review,
    requestPreview,
    confirm,
    cancel: () => setReview(undefined),
  };
}

export type AgentAccessPolicyView = ReturnType<typeof useAgentAccessPolicies>;
