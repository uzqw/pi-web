// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine, Project, SessionInfo, SessionStatus, Workspace } from "../../api";
import type { MachineStatusSnapshot } from "../../../../shared/machineStatus";
import { machineStatusSnapshot } from "../../machineStatus.testSupport";
import { MachineList } from "../MachineList";
import { MachineSwitcher } from "../MachineSwitcher";
import { ProjectList } from "../ProjectList";
import { WorkspaceList } from "../WorkspaceList";
import { AppNavigationPanel, navigationActivityItems, navigationSectionActivity, shouldShowMachinesSection } from "./AppNavigationPanel";

afterEach(() => {
  document.body.replaceChildren();
});

describe("shouldShowMachinesSection", () => {
  it("hides machine navigation when there is no machine choice", () => {
    expect(shouldShowMachinesSection([])).toBe(false);
    expect(shouldShowMachinesSection([machine("local")])).toBe(false);
  });

  it("shows machine navigation when there are multiple machines", () => {
    expect(shouldShowMachinesSection([machine("local"), machine("remote-a")])).toBe(true);
  });
});

describe("header identity", () => {
  it("shows the plain brand without an icon or address", async () => {
    const panel = await mountHeaderPanel([machine("local")]);

    expect(panel.shadowRoot?.querySelector("header strong")?.textContent).toBe("PI WEB");
    expect(panel.shadowRoot?.querySelector(".brand-icon")).toBeNull();
    expect(panel.shadowRoot?.querySelector(".brand-domain")).toBeNull();
  });

  it("keeps the machine switcher visible with a single machine", async () => {
    const panel = await mountHeaderPanel([machine("local")]);

    expect(panel.shadowRoot?.querySelector("machine-switcher")).toBeInstanceOf(MachineSwitcher);
  });

  it("forwards the location-indicator flag to the machine switcher", async () => {
    const panel = await mountHeaderPanel([machine("local")], true);

    expect(section(panel, "machine-switcher", MachineSwitcher).locationIndicator).toBe(true);
  });
});

describe("machine status wiring", () => {
  it("gives machine sections every snapshot and project and workspace sections the selected machine's", async () => {
    const local = machineStatusSnapshot({ machine: { "core:working": true } });
    const remote = machineStatusSnapshot({ machine: { "core:unread": true } });
    const panel = await mountPanel({ local, "remote-a": remote }, machine("local"));

    expect(section(panel, "machine-switcher", MachineSwitcher).statusSnapshots).toEqual({ local, "remote-a": remote });
    expect(section(panel, "machine-list", MachineList).statusSnapshots).toEqual({ local, "remote-a": remote });
    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBe(local);
    expect(section(panel, "workspace-list", WorkspaceList).statusSnapshot).toBe(local);
  });

  it("reads the local machine's snapshot before a machine has been selected", async () => {
    // `selectedMachine` is undefined until machines load, and can stay undefined
    // if that load fails, while local project rows already render. The app keys
    // snapshots by `selectedMachine?.id ?? LOCAL_MACHINE_ID`, so this panel must
    // resolve the same id instead of blanking every indicator.
    const local = machineStatusSnapshot({ projects: { "project-1": { "core:working": true } } });
    const panel = await mountPanel({ local }, undefined);

    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBe(local);
    expect(section(panel, "workspace-list", WorkspaceList).statusSnapshot).toBe(local);
  });

  it("leaves project and workspace sections without a snapshot when the selected machine has none", async () => {
    const panel = await mountPanel({ "remote-a": machineStatusSnapshot() }, machine("local"));

    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBeUndefined();
    expect(section(panel, "workspace-list", WorkspaceList).statusSnapshot).toBeUndefined();
  });
});

describe("navigationActivityItems", () => {
  it("lists lit projects at project granularity and the selected project's lit workspaces at workspace granularity", () => {
    const snapshot = machineStatusSnapshot({
      projects: { "project-1": { "core:working": true }, "project-2": { "core:unread": true } },
      workspaces: { "ws-1": { "core:unread": true }, "ws-2": {} },
    });

    expect(navigationActivityItems({
      machineId: "local",
      snapshot,
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1"), workspace("ws-2", "project-1")],
    })).toEqual([
      { kind: "workspace", machineId: "local", projectId: "project-1", workspaceId: "ws-1" },
      { kind: "project", machineId: "local", projectId: "project-2" },
    ]);
  });

  it("ignores lit nodes the sidebar does not load: unknown projects and unlit workspaces", () => {
    const snapshot = machineStatusSnapshot({
      projects: { ghost: { "core:working": true } },
      workspaces: { "ws-2": { "core:working": true } },
    });

    expect(navigationActivityItems({
      machineId: "local",
      snapshot,
      projects: [project("project-1")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1"), workspace("ws-2", "project-1")],
    })).toEqual([
      { kind: "workspace", machineId: "local", projectId: "project-1", workspaceId: "ws-2" },
    ]);
  });

  it("falls back to project granularity for every project when none is selected", () => {
    const snapshot = machineStatusSnapshot({ projects: { "project-1": { "core:working": true } } });

    expect(navigationActivityItems({
      machineId: "local",
      snapshot,
      projects: [project("project-1")],
      selectedProject: undefined,
      workspaces: [],
    })).toEqual([
      { kind: "project", machineId: "local", projectId: "project-1" },
    ]);
  });

  it("returns nothing without a snapshot", () => {
    expect(navigationActivityItems({ machineId: "local", snapshot: undefined, projects: [], selectedProject: undefined, workspaces: [] })).toEqual([]);
  });
});

describe("navigationSectionActivity", () => {
  const snapshot = machineStatusSnapshot({
    projects: { "project-1": { "core:working": true } },
    workspaces: { "ws-1": { "core:unread": true } },
  });
  const options = {
    machines: [machine("local")],
    machineStatusSnapshots: { local: snapshot },
    snapshot,
    projects: [project("project-1")],
    workspaces: [workspace("ws-1", "project-1")],
    sessions: [session("session-1")],
    sessionStatuses: {},
    sessionActivities: {},
    sendingPrompts: {},
    unreadSessionIds: new Set<string>(),
  };

  it("rolls up the listed rows' flags for project and workspace tabs", () => {
    expect(navigationSectionActivity("projects", options)).toEqual({ kind: "session", unread: false });
    expect(navigationSectionActivity("workspaces", options)).toEqual({ kind: undefined, unread: true });
  });

  it("rolls up every machine snapshot for the machines tab", () => {
    const machines = machineStatusSnapshot({ machine: { "core:terminal": true } });
    const idle = machineStatusSnapshot();
    expect(navigationSectionActivity("machines", { ...options, machines: [machine("a"), machine("b")], machineStatusSnapshots: { a: machines, b: idle } })).toEqual({ kind: "terminal", unread: false });
  });

  it("resolves sessions from their own rows: unread and client-side sending", () => {
    const statuses = { "session-1": sessionStatus({ isStreaming: true }) };
    expect(navigationSectionActivity("sessions", { ...options, sessionStatuses: statuses })).toEqual({ kind: "session", unread: false });
    expect(navigationSectionActivity("sessions", { ...options, sendingPrompts: { "session-1": true } })).toEqual({ kind: "sending", unread: false });
    expect(navigationSectionActivity("sessions", { ...options, unreadSessionIds: new Set(["session-1"]) })).toEqual({ kind: undefined, unread: true });
  });
});

describe("desktop tab row", () => {
  it("renders one tab per section with name, count, and activity, machines only when a machine choice exists", async () => {
    const snapshot = machineStatusSnapshot({ projects: { "project-1": { "core:working": true } } });
    const panel = await mountTabbedPanel((candidate) => {
      candidate.machines = [machine("local"), machine("remote-a")];
      candidate.machineStatusSnapshots = { local: snapshot };
    });
    const tabs = panel.shadowRoot ? [...panel.shadowRoot.querySelectorAll<HTMLElement>(".section-tab")] : [];

    expect(tabs.map((tabEl) => tabEl.querySelector(".section-tab-name")?.textContent)).toEqual(["Machines", "Projects", "Workspaces", "Sessions"]);
    expect(tab(tabs, "Projects").querySelector(".section-tab-count")?.textContent).toBe("1");
    expect(tab(tabs, "Projects").querySelector(".activity-indicator")).not.toBeNull();
    expect(tab(tabs, "Sessions").querySelector(".activity-indicator")).toBeNull();
  });

  it("omits the machines tab without a machine choice", async () => {
    const panel = await mountTabbedPanel();
    const tabs = panel.shadowRoot ? [...panel.shadowRoot.querySelectorAll<HTMLElement>(".section-tab")] : [];

    expect(tabs.map((tabEl) => tabEl.querySelector(".section-tab-name")?.textContent)).toEqual(["Projects", "Workspaces", "Sessions"]);
  });

  it("highlights the open tab and renders only its list on desktop", async () => {
    const panel = await mountTabbedPanel();

    expect(tab(panel, "Projects").classList.contains("active")).toBe(true);
    expect(tab(panel, "Sessions").classList.contains("active")).toBe(false);
    expect(panel.shadowRoot?.querySelector("project-list")).toBeInstanceOf(ProjectList);
    expect(panel.shadowRoot?.querySelector("workspace-list")).toBeNull();
    expect(panel.shadowRoot?.querySelector("session-list")).toBeNull();
  });

  it("reports a tab click for switching", async () => {
    const panel = await mountTabbedPanel();
    const onSelectTab = vi.fn();
    panel.onSelectTab = onSelectTab;

    tab(panel, "Sessions").click();

    expect(onSelectTab).toHaveBeenCalledWith("sessions");
  });

  it("lights the sessions tab from listed-session unread", async () => {
    const panel = await mountTabbedPanel((candidate) => {
      candidate.unreadSessionIds = new Set(["session-1"]);
    });

    expect(tab(panel, "Sessions").querySelector(".activity-indicator.unread")).not.toBeNull();
  });
});

describe("desktop activity row", () => {
  it("lists the selected project's lit workspaces and every other lit project", async () => {
    const snapshot = machineStatusSnapshot({
      projects: { "project-1": { "core:working": true }, "project-2": { "core:unread": true } },
      workspaces: { "ws-1": { "core:unread": true }, "ws-2": {} },
    });
    const panel = await mountTabbedPanel((candidate) => {
      candidate.projects = [project("project-1"), project("project-2")];
      candidate.machineStatusSnapshots = { local: snapshot };
    });
    const chips = panel.shadowRoot ? [...panel.shadowRoot.querySelectorAll(".activity-chip")] : [];

    expect(chips.map((chip) => chip.querySelector(".activity-chip-name")?.textContent)).toEqual(["ws-1", "project-2"]);
  });

  it("reports a clicked workspace chip for jumping", async () => {
    const snapshot = machineStatusSnapshot({ workspaces: { "ws-1": { "core:unread": true } } });
    const onJumpToActivity = vi.fn();
    const panel = await mountTabbedPanel((candidate) => {
      candidate.machineStatusSnapshots = { local: snapshot };
      candidate.onJumpToActivity = onJumpToActivity;
    });

    activityChip(panel, "ws-1").click();

    expect(onJumpToActivity).toHaveBeenCalledWith({ kind: "workspace", machineId: "local", projectId: "project-1", workspaceId: "ws-1" });
  });

  it("renders no activity row when nothing is lit", async () => {
    const panel = await mountTabbedPanel();

    expect(panel.shadowRoot?.querySelector(".activity-row")).toBeNull();
  });
});

async function mountPanel(machineStatusSnapshots: Record<string, MachineStatusSnapshot>, selectedMachine: Machine | undefined): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  panel.compact = true;
  panel.machines = [machine("local"), machine("remote-a")];
  if (selectedMachine !== undefined) panel.selectedMachine = selectedMachine;
  panel.projects = [project("project-1")];
  panel.workspaces = [workspace("ws-1", "project-1")];
  panel.machineStatusSnapshots = machineStatusSnapshots;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function section<T>(panel: AppNavigationPanel, selector: string, type: abstract new (...args: never) => T): T {
  const element = panel.shadowRoot?.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Expected a ${selector} section`);
  return element;
}

async function mountHeaderPanel(machines: Machine[], locationIndicator = false): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  panel.machines = machines;
  panel.locationIndicator = locationIndicator;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

async function mountTabbedPanel(apply: (panel: AppNavigationPanel) => void = () => undefined): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  Object.assign(panel, {
    tabbed: true,
    machines: [machine("local")],
    selectedMachine: machine("local"),
    projects: [project("project-1")],
    selectedProject: project("project-1"),
    workspaces: [workspace("ws-1", "project-1")],
    sessions: [session("session-1")],
    machineStatusSnapshots: { local: machineStatusSnapshot() },
    machinesCollapsed: true,
    projectsCollapsed: false,
    workspacesCollapsed: true,
    sessionsCollapsed: true,
  });
  apply(panel);
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function tab(panelOrTabs: AppNavigationPanel | HTMLElement[], name: string): HTMLElement {
  const tabs: HTMLElement[] = panelOrTabs instanceof AppNavigationPanel
    ? (panelOrTabs.shadowRoot ? [...panelOrTabs.shadowRoot.querySelectorAll<HTMLElement>(".section-tab")] : [])
    : panelOrTabs;
  const match = tabs.find((tabEl) => tabEl.querySelector(".section-tab-name")?.textContent === name);
  if (match === undefined) throw new Error(`Expected a ${name} tab`);
  return match;
}

function activityChip(panel: AppNavigationPanel, name: string): HTMLElement {
  const chips: HTMLElement[] = panel.shadowRoot ? [...panel.shadowRoot.querySelectorAll<HTMLElement>(".activity-chip")] : [];
  const match = chips.find((chip) => chip.querySelector(".activity-chip-name")?.textContent === name);
  if (match === undefined) throw new Error(`Expected a ${name} activity chip`);
  return match;
}

function session(id: string): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
  };
}

function sessionStatus(overrides: Partial<Pick<SessionStatus, "isStreaming" | "isCompacting" | "isBashRunning" | "pendingMessageCount">> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}

function workspace(id: string, projectId: string): Workspace {
  return { id, projectId, path: `/repo/${id}`, label: id, isMain: true, effectiveConfig: {} };
}
