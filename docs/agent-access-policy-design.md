# Agent Groups: implemented design

Agent Groups set shared MCP connection defaults for agents. Each agent has zero or one group and
can have explicit On or Off exceptions. The host stores and enforces these settings. Sidebar
sections and human Roles keep their existing functions.

This document describes the implementation of [the proposal](agent-access-policy-proposal.md)
on `imjoshin/agent-groups`. Internal types use `AgentAccessPolicy`; Group is a UI term.

## Ownership and data

`packages/contracts/src/agent-access-policy.ts` defines Effect schemas and derived types for the
snapshot, mutations, previews, and results. `src/backend/database/agent-access-policy-store.ts`
owns SQLite persistence. `src/backend/agent/agent-access-policy.ts` owns authorization, resolution,
previews, mutations, and runtime refresh coordination through `AgentService`.

Migration 61 adds four tables. The latest schema uses the same table definitions.

| Table | Data |
| --- | --- |
| `agent_access_policies` | Stable policy ID, name, revision, future-connection default, saved connection choices |
| `agent_access_policy_memberships` | Agent ID, optional policy ID, explicit overrides |
| `agent_access_policy_state` | Host revision and connection signature |
| `agent_access_policy_refreshes` | Durable markers for agents whose runtime must refresh |

Policies are separate from agent summary JSON. An old client can edit an agent without erasing
its policy. The migration creates no example groups and changes no existing agent grants. There
is no conversion from `disabledMcpServerIds`: that field was an abandoned feature attempt.

The host resolves each connection by its stable ID. An explicit agent override wins over the
group choice. Without either, an ungrouped agent allows the connection. New groups start with
current and future connections Off. Host availability remains a separate gate: an On policy
cannot enable a disabled or disconnected connection.

At first registration, the host records each group's future-connection choice before it exposes
the connection. Later changes to that default affect future registrations only. Renames,
reauthentication, and temporary absence retain choices. Saved choices for absent connections
remain in storage. A new ID is a new connection.

## Preview and commit

Owners and admins can change policies. Agent edit rights and MCP catalog management rights do
not grant this authority. Agent tools cannot change a policy. The backend checks authority even
when a request arrives through another adapter.

Every mutation carries `expectedRevision`. The preview reports affected agents, On and Off
changes, and overrides removed or retained. Apply recomputes the change against the current
revision in a transaction. A stale request fails and the client reloads the snapshot.

Group edits retain overrides. Assigning or moving an agent clears overrides by default; an
explicit choice can retain them. Removing a group assignment preserves the resolved choices.
Deleting a populated group requires a destination. Moving members to another group uses that
group's defaults; selecting No group retains denials as overrides. Sync removes all agent
overrides. Reset to defaults does the same for an ungrouped
agent, so it can enable access. Both actions show a review before apply.

Creation with a group commits membership before the first turn or publication. A duplicate or
agent-created child inherits the source agent's policy and overrides before it becomes visible.
Workspace, conversation, and public agent identity remain intact during policy changes.

## Runtime enforcement and recovery

Managed MCP lists, discovery, tool calls, resources, prompts, and provider configuration all use
the resolved agent access. OpenBot gateway calls and OAuth/GitHub proxy calls check current access.
Direct HTTP and stdio providers receive permitted configurations and rely on runtime refresh.
This covers supported MCP-backed built-ins, including GitHub. Computer Use and non-MCP tools
keep their existing controls.

A policy mutation that changes an available effective toolset rejects affected active, starting,
compacting, or provider-child work. Unaffected agents continue to use their sessions. A successful
transaction records refresh work durably. New starts wait for that work; a failed refresh returns
`refreshPending` and does not allow a start with stale permissions. After restart, a start attempt
retries the saved work; there is no boot-wide retry scan.

All selected runtimes are marked for refresh before the first asynchronous release. For a
preserved provider session, old routing is removed before waiting for its process to close. This
prevents a late close from removing routing for a session that has just resumed. Existing global
MCP edits retain their active-turn deferral behavior.

Codex fingerprints include the current agent's managed configuration and relevant native keys.
Disabled approval placeholders for other OpenBot agents do not change that fingerprint. Stable
OAuth and GitHub bound addresses survive restart. An upstream token refresh alone does not rotate
a session. A changed proxy port changes the binding ID and replaces the Codex provider session.

OAuth and GitHub proxy requests use agent-scoped routes and bearers. Each request checks current
access. Legacy unscoped access is denied. These controls restrict managed MCP access; they do not
isolate shell commands, arbitrary network access, browser data, or information already in history.

## Process and network boundaries

Main owns IPC handlers and Team API adapters. Preload validates host replies and exposes typed
methods. Effect is bundled into the sandboxed preload; Electron isolation and sender validation
remain enabled.

Remote operations use the optional `agent-access-policy-v1` capability on Team API v9. Released
adapters and payload meanings remain unchanged. Unsupported hosts do not expose the controls.
New policy requests authorize the role and capability before decoding mutation details. Malformed
input returns a non-retryable protocol error. Hidden and missing agents have the same public
not-found response.

Members retain the released route to create ungrouped agents, which allow enabled connections by
default. The new grouped-creation route requires admin authority. Agent Groups govern a given
agent's connections; they do not set human members' access through agents they can create or use.

Named MCP diagnostics go only to current sessions with MCP catalog authority: owners, admins, or
members with the existing negotiated MCP management permission. Audit entries record the change
kind and actor. They do not contain connection secrets or full policy payloads.

## Clients

`packages/ui/src/features/servers/AgentGroups.tsx` owns shared SolidJS group and agent permission
controls. Desktop and browser adapters supply data and actions. Server settings has separate Roles
and Agent Groups destinations. Agent settings shows inherited choices, explicit exceptions,
availability, source text, and Sync. Creation offers a group selection.

The native client uses the same contracts through `packages/team-client`. Policy data remains
online host data and is not added to the phone's offline workspace cache. Request state is scoped
to account, server, and authorization. A scope change clears pending reviews and errors. Same-host
status updates do not discard a review or reopen an old settings destination.

Clients load on entry and use mutation responses. This version adds no policy-change push event.
A second client's stale review fails safely and reloads; an already open idle view is not a live
subscription. All interface text uses the i18n catalogs. New untranslated strings use the declared
fallback list until translations are available.

## Transfer

ZIP format v2 carries policy metadata. Existing unrestricted v1 imports keep their behavior.
Old readers reject v2 rather than silently dropping restrictions. Whole-host transfer preserves
policy relationships and maps imported connections using the exact IDs returned by import.
Imported MCP connections remain disabled until the destination enables them.

A restricted individual export can omit server settings. Import then requires an explicit
destination policy for each selected agent and a unique destination mapping for every source
connection, including built-ins. The staged token belongs to its initiating user. The exact mapping
must have a preview before apply. The first creation checks the host revision atomically; later
creations check the selected policy revision and connection set.

Mapping preserves source effective choices and explicit exceptions. It adds overrides where the
destination defaults differ and denies destination connections absent from the source. Failed
creation rolls back the workspace. Legacy apply cannot bypass this review and leaves the staged
token available for a capable client.

Restricted agents cannot publish to Marketplace or as shared templates. Those formats do not
carry policy metadata, so publication would lose restrictions.

## Validation and limits

Independent GPT-6.1 Sol agents used High reasoning to test each area after author feedback.
Repeatable scripts write reports under `.openbot-build/`. The following checks passed locally:

| Area | Evidence |
| --- | --- |
| Migration | 56 migration-61 cases, source schemas 8–60, file-backed rollback/reopen/retry; 4 schema parity cases; all 29 older migration fixture files |
| Host enforcement | 19 scenarios in `scripts/agent-access-policy-e2e.ts`: inheritance, reverse actions, concurrent revisions, creation, busy states, refresh recovery, discovery, calls, and Codex reuse |
| OAuth and GitHub | 22 OAuth cases and 22 agent-access HTTP cases, including revoke, restart bindings, occupied-port rotation, and redaction |
| Team boundary | 27 signed-frame cases, 14 IPC coverage cases, 3 protected preload decoder cases, and 10 MCP catalog/event-authority cases |
| Provider lifecycle | Real Claude adapter/process flow with a local stand-in: affected refresh, unaffected reuse, routing after a concurrent old-process close, and a background child that blocks edits after its parent ends |
| Transfer | 59 cases in `scripts/instance-transfer-everything-e2e.ts`, including v2 preservation and reviewed individual mapping |
| Desktop and browser | 16 live checks against one local host, including overrides, Sync, moves, deletion, stale revisions, rename, creation, transfer, and light/dark views |
| Desktop restart | The same dev profile retained policy IDs, names, revisions, choices, memberships, and overrides after a complete stack restart |
| Android | Nine live check areas on Pixel_9_Pro / Android 17: group editing, assignment, exceptions, Sync, removal, reassignment, populated deletion, creation selection/cancel, and restricted transfer with header/cancel recovery |
| Packaging | The actual dev preload bundle passed 829 endpoint checks and loaded in the sandboxed app |

The Android test used a local debug APK and unsigned local Metro. Windows setup required generated
Gradle path normalization, a shorter local CMake object-path limit, and a debug-only manifest
override for Metro. The tracked plugin and production signing configuration remain unchanged.
The file picker paused WebRTC once; choosing the same ZIP again after reconnect succeeded. A
stale disabled Import header found by this run was fixed and retested from a cold-loaded bundle.

The provider process tests use local stand-ins, not paid provider services. iOS, OTA signing and
update delivery, a separate joined desktop, live old-host/non-admin control visibility, and a live
two-server switch with a pending request remain unverified. Native scopes and cache exclusions
were reviewed in source. Native creation selection and cancel were checked; the first-turn
guarantee was checked in the service and desktop flows. The host harness did not exercise every
provider runtime. The pre-commit hook passed mobile type validation. Release builds and broad
tests remain for CI.

CI runs the host policy suite and the existing legacy client, MCP member access, and
provider session checks. Run the full HTTP agent access, MCP OAuth, and instance transfer suites
locally with `bun scripts/agent-access-e2e.ts`, `bun run test:mcp-oauth`, and
`bun scripts/instance-transfer-everything-e2e.ts`. The live UI runner, screenshots, local test
reports, and demo are local review artifacts.
