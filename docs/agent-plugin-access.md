# Agent access

Open **Agent settings → Permissions** on the computer that runs the agent. The **Access** section lists MCP connections directly on that page. Each switch controls one configured MCP connection. New agents and new connections default to On. The separate Computer Use setting still controls Computer Use. GitHub appears when its built-in connector is available.

Off removes that connection from the agent's provider MCP configuration, tool discovery, MCP management tools, and Marketplace connection checks. A connection that is off in Server settings remains unavailable even when the agent's switch is On. Separate connections to the same service have separate switches.

The agent must be idle before a switch can change. Running tasks, compaction, starts, and background provider subagents block the change. The operation holds new starts, saves the setting, refreshes the agent's provider sessions, and then releases queued work. Public conversation history stays in place.

The local agent JSON in SQLite stores `disabledMcpServerIds`. A missing or empty list allows all connections. Duplication copies the list. An unrelated edit keeps it, including IDs for connections that are temporarily absent. Invalid saved restrictions fail closed. The local `agent:plugins:list` and `agent:plugins:set` IPC endpoints expose only connection IDs, names, availability, and access. Released Team API protocols do not carry this setting; remote settings hide the Access section.

This controls MCP connections supplied by OpenBot. It does not revoke service credentials, shell access, provider integrations configured outside OpenBot, or information already in conversation history. Skills keep their separate settings. Disabling GitHub's MCP does not sign out `gh` or Git.

## Checks

- `bun scripts/agent-plugin-access-e2e.ts`: real service and SQLite, defaults, isolation, persistence, failed-save rollback, busy refusal, duplication, and re-enable.
- `bun scripts/agent-mcp-tools-e2e.ts`: real local MCP servers, hidden discovery, denied probes and mutations, same-endpoint accounts, and re-enable.
- `bun scripts/acp-mcp-server-names-e2e.ts`: real ACP driver with a fake provider, filtered starts, resume changes, and unrestricted peer sessions.
- `bun scripts/mcp-oauth-e2e.ts`: previously issued routes refuse calls after Off, another agent stays connected, and On restores access.
- Storybook **Settings / Shared Agent Form / Access**: the inline Permissions section, switches, global availability, and saved state after reopening.

On Windows, the first two scripts can use `node --import tsx` when Bun's SQLite implementation keeps temporary database files locked after close. No external account is used by these tests.
