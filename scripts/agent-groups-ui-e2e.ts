// Drives Agent Groups on the isolated dev profile. Only the free model's normal welcome turn runs.
// Run: bun scripts/agent-groups-ui-e2e.ts --instance=<id> --allow-mutations [--api=<local auth URL>]
// Reports and screenshots are in .openbot-build/agent-groups/ui-validation.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LOCAL_SERVER_ID, type McpServerConfig } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { argument, writeReport } from "./channel-e2e-support";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";
import { snapshotPage } from "./dev-automation/tools";

const instanceId = argument("instance");
assert.ok(instanceId && instanceId !== "default", "Pass the ID of the isolated dev profile.");
assertMutationAllowed({
  command: "agent-groups-ui-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instanceId,
});
const instance = readDevInstanceRecords().find(
  (record) =>
    record.service === "app" &&
    record.instanceId === instanceId &&
    resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.ok(instance, "The named profile must belong to this worktree.");
const out = "agent-groups/ui-validation";
const directory = resolve(".openbot-build", out);
mkdirSync(directory, { recursive: true });
const run = argument("run") ?? crypto.randomUUID().slice(0, 6);
const startAt = Number(argument("start-at") ?? 1);
const report: {
  instanceId: string;
  run: string;
  startAt: number;
  passed: boolean;
  steps: { name: string; passed: boolean; error?: string }[];
  screenshots: string[];
  pageErrors: string[];
  lastScreen: string;
  unverified: string[];
} = {
  instanceId,
  run,
  startAt,
  passed: false,
  steps: [],
  screenshots: [],
  pageErrors: [],
  lastScreen: "",
  unverified: [
    "Native device interaction",
    "Joined desktop",
    "Old-host and non-admin controls",
    "Scope switch with a pending request",
  ],
};
const session = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("agent-groups-ui-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const desktop = session.page;
const t = translateFor("en");
const api = argument("api");
const browserOnly = process.argv.includes("--browser-only");
const transferOnly = process.argv.includes("--transfer-only");
const visualsOnly = process.argv.includes("--visuals-only");
const browserFixture = process.argv.includes("--browser-fixture");
if (browserOnly || transferOnly) assert.ok(api && argument("run"), "Pass the dev API URL and an existing run.");
const work = `Work ${run}`;
const personal = `Personal ${run}`;
const temporary = `Review ${run}`;
const agentName = browserFixture ? `Browser Planner ${run}` : `Project Planner ${run}`;
const workConnection = `work_notes_${run}`;
const personalConnection = `personal_notes_${run}`;
const nextConnection = `new_notes_${run}`;
const local = LOCAL_SERVER_ID;
const stdioFixture = resolve(import.meta.dirname, "fixtures/agent-groups-mcp.mjs");
let browser: Browser | undefined;
let currentPage = desktop;
let stepNumber = 0;
desktop.setDefaultTimeout(15_000);
desktop.on("pageerror", (error) => report.pageErrors.push(`Desktop: ${error.message}`));

function button(scope: Page | Locator, name: string | RegExp) {
  return scope.getByRole("button", { name, exact: typeof name === "string" });
}

function toggle(scope: Page | Locator, name: string) {
  return scope.getByRole("switch", { name, exact: true });
}

function review(page: Page) {
  return page.getByRole("alertdialog", { name: t("server.agentGroups.preview"), exact: true });
}

async function confirm(page: Page, name = t("server.agentGroups.confirm")) {
  await button(review(page), name).click();
  await review(page).waitFor({ state: "hidden" });
}

async function pick(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(`^${label}( |$)`) })
    .or(page.getByRole("combobox", { name: label, exact: true }))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function closeServerSettings(page: Page) {
  await page.keyboard.press("Escape");
  await page.getByRole("tablist", { name: t("server.settings.sections") }).waitFor({ state: "hidden" });
}

async function openGroups(page: Page) {
  const permissions = page.getByRole("tab", { name: t("server.agentGroups.permissions"), exact: true });
  if (!(await permissions.isVisible())) {
    await button(page, /^Open server menu for /).click({ button: "right" });
    await page.getByRole("menuitem", { name: t("server.rail.settings"), exact: true }).click();
  }
  await permissions.click();
  await button(page, t("server.settings.rolesTitle")).waitFor();
  await button(page, t("server.agentGroups.title")).click();
  await button(page, t("server.agentGroups.create")).waitFor();
}

async function signIn(web: Page, url: string) {
  await web.goto(new URL("/app", url).href);
  await web
    .getByRole("textbox", { name: t("account.login.email"), exact: true })
    .fill(argument("email") ?? "openbot-dev-host@example.com");
  await button(web, t("account.login.sendCode")).click();
  const code = web.getByText(/^Development code: /);
  await code.waitFor();
  const digits = (await code.innerText()).replace(/^Development code: /, "").replace(/[^A-Za-z0-9]/g, "");
  assert.ok(digits.length === 8, "The development code is missing.");
  await web.keyboard.type(digits);
}

async function agentPermissions(page: Page) {
  const source = button(page, t("server.agentGroups.viewGroups"));
  if (await source.isVisible()) return;
  const row = page.getByRole("navigation", { name: t("sidebar.nav.label") }).getByRole("button", {
    name: new RegExp(`^${agentName}(,|\\.|$)`),
  });
  await row.click();
  const permissions = button(page, /^Permissions(?: |$)/);
  if (!(await permissions.isVisible())) {
    await button(page, t("conversation.sidePanel.openPane", { name: t("conversation.sidePanel.pane.settings") }))
      .or(button(page, t("conversation.header.settings")))
      .first()
      .click();
  }
  await permissions.click();
  await source.waitFor();
}

async function step(name: string, action: () => Promise<void>) {
  stepNumber += 1;
  if (stepNumber < startAt) return;
  process.stdout.write(`- ${name}\n`);
  try {
    await action();
    report.steps.push({ name, passed: true });
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function shot(page: Page, name: string) {
  const loading = page.getByRole("status").filter({ hasText: t("app.loading") });
  await loading.waitFor({ state: "hidden" });
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  report.screenshots.push(path);
}

function read() {
  return desktop.evaluate((id) => window.openbot.agentAccessPolicy.list(id), local);
}

async function policy(name: string) {
  const row = (await read()).policies.find((candidate) => candidate.name === name);
  assert.ok(row, `Missing group: ${name}`);
  return row;
}

async function agent() {
  const row = (await read()).agents.find((candidate) => candidate.name === agentName);
  assert.ok(row, `Missing agent: ${agentName}`);
  return row;
}

async function waitUntilIdle() {
  const current = await agent();
  await desktop.waitForFunction(
    async (agentId) => {
      const [conversation, queue] = await Promise.all([
        window.openbot.agent.readConversation(agentId),
        window.openbot.agent.listQueue(agentId),
      ]);
      return conversation.activeTurnId === null && !queue.welcome;
    },
    current.id,
    { polling: 200 },
  );
}

async function captureThemes() {
  const appearance = await desktop.evaluate(() => window.openbot.getAppAppearancePreference());
  try {
    for (const mode of ["light", "dark"] as const) {
      await desktop.evaluate((appearance) => window.openbot.setAppAppearancePreference({ appearance }), mode);
      await desktop.waitForFunction(
        (scheme) =>
          document.documentElement.dataset.openbotColorScheme === scheme &&
          !document.documentElement.matches(":active-view-transition"),
        mode,
      );
      await button(desktop, t("server.agentGroups.viewGroups")).focus();
      await shot(desktop, `desktop-permissions-${mode}`);
    }
  } finally {
    await desktop.evaluate((original) => window.openbot.setAppAppearancePreference(original), appearance);
  }
}

async function connection(name: string) {
  const row = (await read()).connections.find((candidate) => candidate.name === name);
  assert.ok(row, `Missing connection: ${name}`);
  return row;
}

function saveConnection(name: string, id = "") {
  // One local MCP fixture with distinct configuration IDs and account data.
  const config: McpServerConfig = {
    id,
    name,
    enabled: true,
    transport: "stdio",
    command: "node",
    args: [stdioFixture, name.includes("personal") || name.includes("new_notes") ? "personal" : "work"],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  };
  return desktop.evaluate(({ config, local }) => window.openbot.agent.saveMcpServer({ config }, local), {
    config,
    local,
  });
}

async function addConnection(name: string) {
  const prior = (await read()).connections.find((candidate) => candidate.name === name);
  if (prior) return prior;
  await saveConnection(name);
  return connection(name);
}

async function editGroup(page: Page, name: string, action: () => Promise<void>) {
  await button(page, name).click();
  await action();
  await button(page, t("common.save")).click();
  await confirm(page);
  await button(page, name).waitFor();
}

async function createGroup(page: Page, name: string, allowed: string) {
  await button(page, t("server.agentGroups.create")).click();
  await page.getByRole("textbox", { name: t("server.agentGroups.name") }).fill(name);
  assert.equal(await toggle(page, t("server.agentGroups.newConnections")).isChecked(), false);
  for (const label of [workConnection, personalConnection]) assert.equal(await toggle(page, label).isChecked(), false);
  await toggle(page, allowed).press("Space");
  await button(page, t("common.save")).click();
  await confirm(page);
  await button(page, name).waitFor();
  const row = await policy(name);
  assert.equal(row.allowNewConnections, false);
  assert.ok(!(await read()).agents.some(({ policyId }) => policyId === row.id));
}

async function override(page: Page, name: string, before: boolean) {
  const control = toggle(page, name);
  assert.equal(await control.isChecked(), before);
  await control.press("Space");
  await confirm(page);
  assert.equal(await control.isChecked(), !before);
}

async function assign(page: Page, name: string, keep = false) {
  await pick(page, t("server.agentGroups.group"), name);
  await review(page).waitFor();
  const keepToggle = toggle(review(page), t("server.agentGroups.keep"));
  if (await keepToggle.isVisible()) {
    assert.equal(await keepToggle.isChecked(), false);
    if (keep) await keepToggle.press("Space");
  } else assert.equal(keep, false);
  if (name === t("server.agentGroups.noGroup"))
    await review(page).getByText(t("server.agentGroups.removeHint"), { exact: true }).waitFor();
  await confirm(page);
  await page
    .getByText(
      name === t("server.agentGroups.noGroup")
        ? t("server.agentGroups.noGroupSource")
        : t("server.agentGroups.groupSource", { name }),
      { exact: true },
    )
    .waitFor();
}

try {
  const reuse = browserOnly || transferOnly || visualsOnly;
  const workRecord = await (reuse ? connection : addConnection)(workConnection);
  const personalRecord = await (reuse ? connection : addConnection)(personalConnection);
  assert.notEqual(workRecord.id, personalRecord.id);
  if (reuse) {
    const ids = new Set([workRecord.id, personalRecord.id, (await connection(nextConnection)).id]);
    const configured = await desktop.evaluate((id) => window.openbot.agent.listMcpServers(id), local);
    for (const config of configured) {
      if (ids.has(config.id) && config.args[0] !== stdioFixture) await saveConnection(config.name, config.id);
    }
  }
  if (browserFixture) {
    assert.ok(reuse, "Use the browser fixture after the desktop test has created the groups.");
    const state = await read();
    if (!state.agents.some(({ name }) => name === agentName)) {
      const planner = state.agents.find(({ name }) => name === `Project Planner ${run}`);
      assert.ok(planner, "Create the desktop planner before the browser fixture.");
      await desktop.evaluate(
        async ({ source, name }) => {
          const copy = await window.openbot.agent.duplicateAgent(source);
          await window.openbot.agent.updateAgent({ agentId: copy.agent.id, name });
        },
        { source: planner.id, name: agentName },
      );
    }
  }

  if (!reuse) {
    await step("Reject a duplicate connection name without changing its ID", async () => {
      await assert.rejects(saveConnection(workConnection), /name|already|unique/i);
      const current = (await read()).connections.filter(({ name }) => name === workConnection);
      assert.deepEqual(
        current.map(({ id }) => id),
        [workRecord.id],
      );
    });

    await step("Create two empty groups with independent connection defaults", async () => {
      await openGroups(desktop);
      await createGroup(desktop, work, workConnection);
      await createGroup(desktop, personal, personalConnection);
      assert.equal((await policy(work)).choices[personalRecord.id], false);
      assert.equal((await policy(personal)).choices[workRecord.id], false);
      await shot(desktop, "desktop-group-list");
    });

    await step("Change the future default without changing existing choices", async () => {
      if (!(await button(desktop, t("server.agentGroups.create")).isVisible())) await openGroups(desktop);
      await editGroup(desktop, personal, () => toggle(desktop, t("server.agentGroups.newConnections")).press("Space"));
      const next = await addConnection(nextConnection);
      assert.equal((await policy(work)).choices[next.id], false);
      const personalPolicy = await policy(personal);
      assert.equal(personalPolicy.choices[next.id], true);
      assert.equal(personalPolicy.choices[workRecord.id], false);
    });

    await step("Create an agent with its group for the first welcome turn", async () => {
      if (!(await read()).agents.some(({ name }) => name === agentName)) {
        if (await desktop.getByRole("tablist", { name: t("server.settings.sections") }).isVisible())
          await closeServerSettings(desktop);
        await button(desktop, /^New agent.*folder$/).click();
        await desktop.getByRole("menuitem", { name: t("sidebar.new.agent"), exact: true }).click();
        await desktop.getByRole("textbox", { name: t("agent.setup.name"), exact: true }).fill(agentName);
        await pick(desktop, t("server.agentGroups.group"), work);
        await button(desktop, /^Agent model: .*Free/).waitFor();
        await shot(desktop, "desktop-create-agent");
        await button(desktop, t("agent.setup.create")).click();
      }
      await agentPermissions(desktop);
      const current = await agent();
      assert.equal(current.policyId, (await policy(work)).id);
      const stop = button(desktop, "Stop agent");
      if (await stop.isVisible()) {
        await shot(desktop, "desktop-welcome-policy");
        await stop.click();
        await stop.waitFor({ state: "hidden" });
      }
      await waitUntilIdle();
    });

    const created = await agent();
    const layout = await desktop.evaluate(() => window.openbot.agent.getSidebarLayout());
    const hostSettings = await desktop.evaluate((id) => window.openbot.agent.getAgentAdminSettings(id), created.id);

    await step("Show inherited and different On and Off settings and preview both Sync changes", async () => {
      await desktop
        .getByText(t("server.agentGroups.inherited", { name: work }), { exact: true })
        .first()
        .waitFor();
      await override(desktop, workConnection, true);
      await override(desktop, personalConnection, false);
      assert.deepEqual((await agent()).overrides, { [workRecord.id]: false, [personalRecord.id]: true });
      await desktop.getByText(t("server.agentGroups.differentOn", { name: work }), { exact: true }).waitFor();
      await desktop.getByText(t("server.agentGroups.differentOff", { name: work }), { exact: true }).waitFor();
      await shot(desktop, "desktop-overrides");
      await button(desktop, t("server.agentGroups.sync")).click();
      await review(desktop)
        .getByText(t("server.agentGroups.enabled", { names: workConnection }))
        .waitFor();
      await review(desktop)
        .getByText(t("server.agentGroups.disabled", { names: personalConnection }))
        .waitFor();
      await shot(desktop, "desktop-sync-preview");
      await desktop.keyboard.press("Escape");
      await review(desktop).waitFor({ state: "hidden" });
      assert.equal(Object.keys((await agent()).overrides).length, 2);
      await button(desktop, t("server.agentGroups.sync")).click();
      await confirm(desktop);
      assert.deepEqual((await agent()).overrides, {});
    });

    await step("Move with cleared and kept overrides, remove, then reset individual denials", async () => {
      await override(desktop, workConnection, true);
      await assign(desktop, personal);
      assert.deepEqual((await agent()).overrides, {});
      await override(desktop, personalConnection, true);
      await assign(desktop, work, true);
      assert.deepEqual((await agent()).overrides, { [personalRecord.id]: false });
      await desktop.getByText(t("server.agentGroups.matches", { name: work }), { exact: true }).waitFor();
      await shot(desktop, "desktop-matching-override");
      await button(desktop, t("server.agentGroups.useGroup")).click();
      await confirm(desktop);
      assert.deepEqual((await agent()).overrides, {});
      await assign(desktop, t("server.agentGroups.noGroup"));
      const removed = await agent();
      assert.equal(removed.policyId, null);
      assert.equal(removed.overrides[personalRecord.id], false);
      await button(desktop, t("server.agentGroups.reset")).click();
      await confirm(desktop);
      assert.deepEqual((await agent()).overrides, {});
      await assign(desktop, work);
    });

    await step("Keep an On override visible when the host disables its connection", async () => {
      await desktop.evaluate(
        ({ id, local }) => window.openbot.agent.setMcpServerEnabled({ mcpServerId: id, enabled: false }, local),
        {
          id: personalRecord.id,
          local,
        },
      );
      await desktop.reload();
      await agentPermissions(desktop);
      await override(desktop, personalConnection, false);
      await desktop.getByText(t("server.agentGroups.unavailable"), { exact: true }).first().waitFor();
      const row = (await agent()).connections.find(({ connectionId }) => connectionId === personalRecord.id);
      assert.ok(row?.allowed);
      assert.equal(row.available, false);
      await shot(desktop, "desktop-unavailable-on");
      await button(desktop, t("server.agentGroups.useGroup")).click();
      await confirm(desktop);
      await desktop.evaluate(
        ({ id, local }) => window.openbot.agent.setMcpServerEnabled({ mcpServerId: id, enabled: true }, local),
        {
          id: personalRecord.id,
          local,
        },
      );
    });

    await step("Reject a stale review and apply it after a fresh preview", async () => {
      await desktop.reload();
      await agentPermissions(desktop);
      await toggle(desktop, personalConnection).press("Space");
      await review(desktop).waitFor();
      const saved = await policy(personal);
      const revision = (await read()).revision;
      await desktop.evaluate(
        ({ saved, revision, local }) =>
          window.openbot.agentAccessPolicy.apply(
            {
              kind: "savePolicy",
              expectedRevision: revision,
              policyId: saved.id,
              name: saved.name,
              allowNewConnections: !saved.allowNewConnections,
              choices: saved.choices,
              assignments: [],
            },
            local,
          ),
        { saved, revision, local },
      );
      await confirm(desktop);
      await button(desktop, t("common.retry")).waitFor();
      assert.deepEqual((await agent()).overrides, {});
      await shot(desktop, "desktop-stale-review");
      await button(desktop, t("common.retry")).click();
      await override(desktop, personalConnection, false);
      assert.equal((await agent()).overrides[personalRecord.id], true);
      await button(desktop, t("server.agentGroups.useGroup")).click();
      await confirm(desktop);
    });

    await step("Delete a populated group only after selecting and reviewing a destination", async () => {
      await button(desktop, t("server.agentGroups.viewGroups")).click();
      await button(desktop, t("server.agentGroups.create")).waitFor();
      await createGroup(desktop, temporary, personalConnection);
      await editGroup(desktop, temporary, () => toggle(desktop, agentName).press("Space"));
      assert.equal((await agent()).policyId, (await policy(temporary)).id);
      await button(desktop, temporary).click();
      await button(desktop, t("server.agentGroups.delete")).click();
      const preview = button(desktop, t("server.agentGroups.preview"));
      assert.equal(await preview.isDisabled(), true);
      await pick(desktop, t("server.agentGroups.deleteDestination"), work);
      await preview.click();
      await review(desktop).getByText(agentName, { exact: true }).waitFor();
      await shot(desktop, "desktop-delete-preview");
      await confirm(desktop, t("server.agentGroups.delete"));
      assert.ok(!(await read()).policies.some(({ name }) => name === temporary));
      assert.equal((await agent()).id, created.id);
      assert.equal((await agent()).policyId, (await policy(work)).id);
      await closeServerSettings(desktop);
    });

    await step("Retain the sidebar and Computer Use settings", async () => {
      assert.deepEqual(await desktop.evaluate(() => window.openbot.agent.getSidebarLayout()), layout);
      assert.deepEqual(
        await desktop.evaluate((id) => window.openbot.agent.getAgentAdminSettings(id), created.id),
        hostSettings,
      );
    });

    await step("Keep access choices when a connection is renamed", async () => {
      const newName = `renamed_${workConnection}`;
      await saveConnection(newName, workRecord.id);
      try {
        await desktop.reload();
        await agentPermissions(desktop);
        await toggle(desktop, newName).waitFor();
        assert.ok(await toggle(desktop, newName).isChecked());
        assert.equal((await connection(newName)).id, workRecord.id);
        assert.equal((await policy(work)).choices[workRecord.id], true);
        assert.equal((await policy(personal)).choices[workRecord.id], false);
      } finally {
        await saveConnection(workConnection, workRecord.id);
      }
    });

    await step("Capture light and dark settings and reach the final control by keyboard", async () => {
      await desktop.reload();
      await agentPermissions(desktop);
      await captureThemes();
      await button(desktop, t("server.agentGroups.viewGroups")).press("Enter");
      await button(desktop, work).waitFor();
      await button(desktop, work).press("Enter");
      const save = button(desktop, t("common.save"));
      await save.scrollIntoViewIfNeeded();
      await save.focus();
      await shot(desktop, "desktop-group-editor-scrolled");
      await save.press("Enter");
      await review(desktop).waitFor();
      await desktop.keyboard.press("Escape");
      await review(desktop).waitFor({ state: "hidden" });
      await closeServerSettings(desktop);
    });
  }

  if (visualsOnly) {
    await step("Capture stable screenshots of override sources and the Sync review", async () => {
      await desktop.reload();
      await agentPermissions(desktop);
      if ((await agent()).policyId !== (await policy(work)).id) await assign(desktop, work);
      const sync = button(desktop, t("server.agentGroups.sync"));
      if (await sync.isVisible()) {
        await sync.click();
        await confirm(desktop);
      }
      await override(desktop, workConnection, true);
      await override(desktop, personalConnection, false);
      await shot(desktop, "desktop-overrides");
      await captureThemes();
      await sync.click();
      await review(desktop).waitFor();
      await shot(desktop, "desktop-sync-preview");
      await confirm(desktop);
    });
  }

  if (api && !visualsOnly) {
    if (!transferOnly) await waitUntilIdle();
    browser = await chromium.launch({ channel: "chrome" });
    const web = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    currentPage = web;
    web.setDefaultTimeout(30_000);
    web.on("pageerror", (error) => report.pageErrors.push(`Browser: ${error.message}`));
    await signIn(web, api);
    await agentPermissions(web);
    if (!transferOnly) {
      await step("Edit the same live host through the browser client", async () => {
        if ((await agent()).policyId !== (await policy(work)).id) await assign(web, work);
        await assign(web, personal);
        assert.equal((await agent()).policyId, (await policy(personal)).id);
        await override(web, workConnection, false);
        await override(web, personalConnection, true);
        await button(web, t("server.agentGroups.sync")).click();
        await review(web)
          .getByText(t("server.agentGroups.enabled", { names: personalConnection }))
          .waitFor();
        await review(web)
          .getByText(t("server.agentGroups.disabled", { names: workConnection }))
          .waitFor();
        await shot(web, "browser-sync-preview");
        await confirm(web);
        assert.deepEqual((await agent()).overrides, {});
      });

      await step("Reload stale browser settings after another client changes inherited access", async () => {
        await assign(web, work);
        const setWorkPersonal = async (allowed: boolean) => {
          const saved = await policy(work);
          const expectedRevision = (await read()).revision;
          await desktop.evaluate(
            ({ saved, expectedRevision, id, allowed, local }) =>
              window.openbot.agentAccessPolicy.apply(
                {
                  kind: "savePolicy",
                  expectedRevision,
                  policyId: saved.id,
                  name: saved.name,
                  allowNewConnections: saved.allowNewConnections,
                  choices: { ...saved.choices, [id]: allowed },
                  assignments: [],
                },
                local,
              ),
            { saved, expectedRevision, id: personalRecord.id, allowed, local },
          );
        };
        const control = toggle(web, personalConnection);
        await control.press("Space");
        await review(web).waitFor();
        await setWorkPersonal(true);
        try {
          await confirm(web);
          await button(web, t("common.retry")).waitFor();
          assert.deepEqual((await agent()).overrides, {});
          await button(web, t("common.retry")).click();
          await control.waitFor();
          assert.ok(await control.isChecked());
        } finally {
          await setWorkPersonal(false);
        }
      });
    }
    await button(web, t("server.agentGroups.viewGroups")).click();
    await button(web, t("server.agentGroups.create")).waitFor();
    await shot(web, "browser-group-list");
    await web.setViewportSize({ width: 580, height: 750 });
    await button(web, t("server.agentGroups.create")).waitFor();
    await shot(web, "browser-group-list-narrow");
    await web.setViewportSize({ width: 1280, height: 900 });

    await step("Map a restricted browser transfer without server settings", async () => {
      await web.getByRole("tab", { name: t("server.settings.transferTitle"), exact: true }).click();
      await button(web, /^Export from this server/).click();
      await toggle(web, t("settings.transfer.export.settings")).press("Space");
      await toggle(web, t("settings.transfer.export.files")).press("Space");
      const history = toggle(web, t("settings.transfer.export.history"));
      if ((await history.isVisible()) && (await history.isChecked())) await history.press("Space");
      await button(web, /^Choose agents/).click();
      const roster = web.getByRole("list", { name: t("settings.transfer.export.agentsLabel") });
      const selected = roster.getByRole("checkbox", { name: t("settings.transfer.includeAgent", { name: agentName }) });
      assert.ok(await selected.isChecked());
      for (const checkbox of await roster.getByRole("checkbox").all()) {
        if (
          (await checkbox.getAttribute("aria-label")) !== t("settings.transfer.includeAgent", { name: agentName }) &&
          (await checkbox.isChecked())
        )
          await checkbox.press("Space");
      }
      const downloaded = web.waitForEvent("download");
      await button(web, t("settings.transfer.export.save")).click();
      const archive = resolve(directory, "restricted-agent.zip");
      await (await downloaded).saveAs(archive);
      await button(web, t("common.back")).click();
      await button(web, /^Import into this server/).click();
      const filePicker = web.waitForEvent("filechooser");
      await button(web, t("settings.transfer.import.choose")).click();
      await (await filePicker).setFiles(archive);
      await button(web, t("settings.transfer.import.submit", { count: 1 })).click();
      const reviewMapping = button(web, t("settings.transferMapping.review"));
      await reviewMapping.waitFor();
      assert.ok(await reviewMapping.isDisabled());
      await pick(web, agentName, personal);
      const before = await read();
      for (const { name, accountLabel } of before.connections) {
        if (await button(web, name).isVisible()) {
          const destination =
            name === workConnection ? personalConnection : name === personalConnection ? workConnection : name;
          await pick(
            web,
            name,
            accountLabel
              ? t("server.agentGroups.connectionLabel", { name: destination, account: accountLabel })
              : destination,
          );
        }
      }
      await shot(web, "browser-transfer-mapping");
      await reviewMapping.click();
      await button(web, t("settings.transferMapping.import")).waitFor();
      await shot(web, "browser-transfer-review");
      await button(web, t("settings.transferMapping.import")).click();
      await web.getByText(t("settings.transfer.result.imported", { count: 1 }), { exact: true }).waitFor();
      const oldIds = new Set(before.agents.map(({ id }) => id));
      const imported = (await read()).agents.filter(({ id }) => !oldIds.has(id));
      assert.equal(imported.length, 1);
      assert.equal(imported[0]?.policyId, (await policy(personal)).id);
      const source = before.agents.find(({ name }) => name === agentName);
      assert.ok(source);
      assert.ok(source.connections.some(({ allowed }) => !allowed));
      assert.equal(
        imported[0]?.connections.find(({ connectionId }) => connectionId === workRecord.id)?.allowed,
        source.connections.find(({ connectionId }) => connectionId === personalRecord.id)?.allowed,
      );
      assert.equal(
        imported[0]?.connections.find(({ connectionId }) => connectionId === personalRecord.id)?.allowed,
        source.connections.find(({ connectionId }) => connectionId === workRecord.id)?.allowed,
      );
    });
  }
  assert.deepEqual(
    report.pageErrors.filter((message) => !message.includes("ResizeObserver loop")),
    [],
  );
  report.passed = true;
} finally {
  if (!report.passed) {
    const snapshot = await snapshotPage(currentPage).catch(() => null);
    report.lastScreen =
      snapshot?.accessibility.replace(/Development code: [^\r\n]*/g, "Development code: [redacted]") ?? "";
  }
  process.stdout.write(`${writeReport(out, report)}\n`);
  await browser?.close();
  await session.close();
}
