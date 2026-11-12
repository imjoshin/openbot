# Draft: Agent Groups for MCP access

Agent Groups give a set of agents the same default MCP connection access. A Work group can allow
work Slack and work email. A Personal group can allow personal Slack, Discord, and messages. An
agent can have its own exceptions. Each agent belongs to zero or one group in v1.

Groups control permissions only. Sidebar sections keep their current purpose and membership.
The proposal uses **Agent Groups** as the requested UI term. Internal names use
`AgentAccessPolicy`, to keep the repository rule that `group` is not a domain type.

This is a design proposal. It does not change the application or publish a GitHub issue or PR.

## Relation to the requests

- [#4306](https://github.com/nightly-labs/openbot/issues/4306) asks for MCP access per role, per
  agent, and per tool. This proposal covers the agent part. Human Roles keep their current
  meaning. Role-to-MCP grants and individual tool permissions remain separate work.
- [#6759](https://github.com/nightly-labs/openbot/issues/6759) and
  [#6718](https://github.com/nightly-labs/openbot/issues/6718) ask for connections to be available
  to selected agents. Groups and agent exceptions provide this selection.
- The comment on #4306 asks for separate MCP environment variables per agent. This is a follow-up,
  as requested, and is outside v1.
- [PR #2138](https://github.com/nightly-labs/openbot/pull/2138) is a previous implementation of
  server and tool selection. It closed without merging. Its review identifies session stability
  across restarts, explicit remote capability checks, and transfer of grants as areas to check.
  Those are review findings about that PR, not confirmed defects in this branch.

The three issues above have no `approved` label at the time of this draft. Seek approval for
this scope before a feature PR. Do not close all of #4306 with the group feature.

## Access rules

Each connection has a stable ID. Work Slack and Personal Slack must be separate connection
records, even when they use the same service or URL. A display name or endpoint is not an identity.

The host resolves access in this order:

1. The connection must be enabled and usable on the host. An agent override cannot bypass this.
2. If the agent has an explicit choice for this connection, use it: On or Off.
3. Otherwise, use the group's choice for this connection.
4. If the agent has no group, use On.

For a grouped agent, the internal choices are **Inherit**, **On**, and **Off**. The main control
remains a toggle showing the resolved policy value. A separate action returns the row to Inherit.
Connection availability and policy are shown separately: an On policy does not mean that a
disconnected or globally disabled connection works.

Groups are defaults, not a hard maximum. An owner or admin can grant an agent a connection that
its group does not allow. The row must show that exception. An agent cannot grant itself access.
Computer Use keeps its separate control. Built-in GitHub and other supported MCP-backed
connections use this policy; built-in non-MCP tools keep their own settings.

## Group defaults and new connections

The group editor has a toggle for each current connection and an **Allow new connections** switch.
For a new group, propose Off for both the current connection list and new connections. The user
selects the initial allowed set before assigning agents. Work and Personal are examples, not
groups created during an upgrade.

The new-connection switch applies when a connection is first registered. Record the group's
choice at that time. Changing the switch later does not change existing connection choices.
This avoids an unexpected change to many existing grants.

Renaming a connection, signing in again, or temporarily disconnecting it keeps its ID and choices.
A deleted and recreated connection with a new ID follows the new-connection default. A built-in
connection introduced by an upgrade follows the same rule before it is exposed to agents.
Do not discard saved denials just because a connection is temporarily missing.

With no group, current and new connections default to On. Saved individual Off choices remain.

## Agent settings

Use **Agent settings → Permissions → MCP connections**. Keep the current page and shared
settings controls. Above the connection list, show:

- **Agent group:** selector with No group and the available groups.
- **View all groups:** opens Server settings → Permissions → Agent Groups on the same server.
- A short source line, such as “Uses Work defaults” or “No group. New connections are allowed.”
- A summary when overrides exist, such as “2 overrides · 1 differs from Work”, with
  **Sync permissions** at the top of the list.

Each connection row shows its account or workspace label, an On/Off toggle, and its source:

- “From Work” for an inherited choice.
- “Different from Work: group is Off” for an On override against an Off group choice.
- “Different from Work: group is On” for an Off override against an On group choice.
- “Custom setting; currently matches Work” if a later group edit now matches a saved override.

Use a warning icon and text for a difference; do not depend on color alone. Every overridden row
has **Use group setting**. The override remains explicit until that action or Sync removes it.
Do not silently remove it when a group edit happens to match it.

**Sync permissions** removes all MCP overrides for this agent and returns to live inheritance.
It does not change the group, other agents, Computer Use, or other permissions. Show a preview of
connections that become On or Off and the number of overrides removed. Confirm the preview before
applying it, because sync can enable access as well as remove it. Without a group, the equivalent
action is **Reset to defaults**, which removes individual Off choices and returns to all On.

## Server settings

Add **Permissions** to Server settings with two destinations:

- **Roles:** which human members can use or manage agents. Preserve current behavior.
- **Agent Groups:** default MCP access for agents.

The Agent Groups list shows each name, agent count, and new-connection default. **Create group**
opens the editor. The editor contains the name, current connection choices, the new-connection
switch, and an agent assignment list. An agent row identifies its current group so a reassignment
is clear. Use the existing list and detail-page pattern from Roles.

Save group edits together. Before a permission or assignment change, show the affected agents,
connections enabled and disabled, and agent overrides that will remain. Distinguish the group's
saved default from an agent's effective access. Do not silently clear agent overrides when saving
the group. An empty group can be created before any agents are assigned.

Owners and admins can create and change groups, assignments, and overrides. Existing agent-edit
access alone does not grant this authority. Agent tools cannot change these policies. A member's
right to add or manage an MCP connection is distinct from the right to assign it to agents.

## Membership and reverse actions

**Assign or move an agent:** preview the new group's effective access. The primary action applies
the new group and clears previous agent overrides. Offer an explicit option to keep overrides,
with a refreshed preview. This prevents a Personal exception from silently following an agent
into Work. A new agent created by a human can select a group before its first turn; No group
keeps the existing default behavior.

**Remove an agent from a group:** preserve its current policy for all registered connections by
converting Off choices to individual denials. State that future connections will default to On.
This keeps current access from increasing as a side effect of removal. The user can then reset
or edit the individual choices.

**Delete a group:** require its agents to be moved to another group or explicitly removed with
the rule above. Show the access changes first. Group deletion never deletes agents, chats, or
workspaces. A missing or invalid referenced group is an error; it must not mean No group.

**Duplicate an agent:** copy the group assignment and explicit overrides. **Agent-created agents**
must inherit their creator's group and restrictions before they can run. An agent must not use
creation to obtain the all-On No group default. A human admin can change the result later.

**Update a group:** inherited rows change for its agents; explicit choices stay in place. Show a
warning when an override now differs. Keep the group ID stable across renames.

## Work and Personal use

Work starts with work Slack and work email On, personal connections Off, and new connections Off.
Personal starts with personal Slack, Discord, and messages On, work connections Off, and new
connections Off. An admin can enable one personal connection for a Work agent as a visible
exception, then use Sync to return to Work defaults.

This requires separate saved connections for the work and personal accounts. If one Composio or
other MCP server exposes both accounts, v1 can allow or deny that server only. It cannot separate
the accounts or tool operations inside it. Verify that the relevant providers support the needed
separate connections before promising this account separation.

The feature limits OpenBot-managed MCP access. It does not separate existing conversation history,
shared files, browser sign-ins, Vault data, direct shell/network access, or messages between agents.
An agent in Work can still ask an agent in Personal for help under current messaging rules. Full
Work/Personal data isolation would need separate rules for these paths. Group membership alone
must not be described as that isolation.

## Implementation proposal

The local branch already stores `disabledMcpServerIds`, filters provider configurations and
discovery, and refreshes idle agent sessions after changes. Extend this work around one policy
resolver instead of adding a second set of checks to each provider.

1. **Store policy on the host.** Add `AgentAccessPolicy` records to `openbot.db`, with a stable ID,
   name, revision, new-connection default, and explicit choices keyed by connection ID. Store an
   optional `mcpAccessPolicyId` and validated On/Off overrides with each local agent record. A
   missing override means Inherit. The host owns the policy for that agent regardless of who
   starts its chat or routine. Do not put grants in Cloudflare or sidebar state.
2. **Preserve existing data.** Add an append-only migration and the matching latest schema.
   Existing agents remain ungrouped. Preserve this branch's saved `disabledMcpServerIds` as Off
   overrides through a one-time conversion, without keeping two mutable sources. Preserve IDs,
   workspaces, chats, provider state, and unrelated JSON fields. Invalid policy data fails closed.
   Cover every supported released schema and the required rollback and failure cases.
3. **Resolve once.** Return the saved source, group value, override, resolved policy value, and
   connection availability. Use the same result for the settings view, provider start and resume,
   tool discovery, managed MCP calls, OAuth proxy routes, and MCP management/Marketplace tools.
   Enforce Off for the whole connection, including resources and prompts where those are exposed.
   Provider adapters must not continue to read only the legacy denial list.
4. **Apply changes atomically.** Check authorization and an expected revision at the host. Hold
   new starts, compute the affected effective tool sets, and reject a change if an affected agent
   is active, starting, compacting, or running a provider subagent. List those agents and let the
   user retry when idle; do not stop work automatically. Commit the group and assignment change
   in one transaction. Name-only or future-default-only edits need no session refresh.
5. **Refresh safely.** Invalidate stale tool routes and refresh affected idle provider sessions
   before their next turn. Preserve public history and agent/thread identity. If storage fails,
   keep the old policy. If refresh fails after commit, show that the policy was saved and keep
   affected starts blocked until refresh succeeds. Do not report a rollback or use old grants.
   Fingerprints must reflect stable connection identity and effective permissions, not a random
   port, token, or an unrelated policy revision. A restart with unchanged access must preserve
   a resumable provider session.
6. **Register new connections safely.** Record the choice for every group before publishing the
   connection. Serialize registration with policy edits and account for member-created servers.
   A group with new connections Off never exposes a new server during the registration interval.
   Use the existing session-update path for agents whose available tool set grows.
7. **Support joined servers.** Add versioned optional Team API routes and a negotiated capability
   for policy reads and writes. Do not change released codecs or reinterpret old fields. Require
   explicit support before showing controls; a missing capability does not mean unrestricted
   access. Old clients remain subject to host policy and preserve it during unrelated agent edits.
   Provide equivalent admin controls on desktop, web, and mobile. Do not add policy secrets to
   the phone's offline cache. Check the current capability budget when implementation starts.
8. **Reuse UI and boundaries.** Put SolidJS components in `packages/ui`, pass typed data/actions,
   and keep renderer adapters outside them. Add IPC registration, preload decoding, the preview
   implementation, localized strings, and the mobile native views together. Use Effect services
   and host-side authorization for operations. Keep settings scoped to the server being edited.
9. **Handle transfer and review.** Preserve policy in supported whole-host transfer. Individual
   imports require explicit mapping to destination groups and connection IDs; an unresolved
   restricted import cannot silently become unrestricted. Extend the existing admin audit path
   for policy changes without credentials or tool arguments. Update architecture, glossary, and
   release notes. Recheck privacy documentation if outbound metadata changes.

Possible ownership: a focused policy service/store in `src/backend`, schemas and optional wire
contracts in `packages/contracts`, IPC and Team adapters in `src/main`, shared controls in
`packages/ui`, renderer wiring in `src/renderer`, and native views in `apps/mobile`. The account
Worker, hosted-site router, and Signal should need no new policy storage or routing logic.

## Acceptance checks and delivery

Use real service/process E2E scripts with JSON reports under `.openbot-build/`, plus protected
migration and trust-boundary tests. Storybook covers visual states only.

- Work and Personal agents see only their effective connections; separate accounts stay distinct.
- New connection defaults, changed future defaults, reconnects, and new IDs behave as specified.
- On and Off overrides work; an override that later matches stays explicit; row reset and Sync
  restore inheritance. Sync previews both grants and removals.
- Assignment, move, removal, group deletion, duplication, and agent-created agents preserve the
  specified access. Group membership has no effect on sidebar sections.
- A globally disabled or unavailable connection stays unusable despite an On override.
- Group changes, busy agents, concurrent edits, failed saves, and failed refreshes do not produce
  partial grants or stale starts. A stale preview requires a new read and preview.
- All managed provider/discovery/call paths use the policy; old routes cannot retain revoked
  access. Scheduled work and provider switches use the same rules.
- Restart with unchanged policy preserves resumable provider state. Access changes preserve
  agent identity, public history, and workspace data.
- Non-admins and agent tools cannot change policy. Joined clients cannot read hidden agent or
  connection metadata. Old clients preserve policy and cannot bypass it with an unrelated save.
- Migration, fresh database, whole-host transfer, and restricted import keep policy and user data.

Seek agreement on this scope first. Then update the branch against current upstream and implement
storage/resolution, mutation rules, remote contracts, and settings as reviewable steps. Run only
focused checks locally, one at a time. Agree the narrow E2E CI selection with maintainers; do not
repeat the unrelated broad CI expansion criticized in PR #2138.

Confirmed for this draft: the three issue bodies and comments, PR #2138's status and review, and
the current branch's policy, UI, role, and protocol entry points. Unverified: compatibility of the
full branch with current upstream, your providers' ability to expose separate work/personal
connections, and transfer behavior for the proposed records. The proposal describes the required
behavior for those areas; it does not claim they are implemented or tested.
