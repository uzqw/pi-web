import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionInfo, SessionStatus, Workspace } from "../api";
import type { StatusFlags } from "../../../shared/machineStatus";
import { NavigationSectionsController } from "../appShell/navigationState";
import { WorkspaceController } from "../controllers/workspaceController";
import type { RouteTarget } from "../controllers/types";
import { PiWebApp } from "./PiWebApp";
import type { NavigationActivityItem } from "./appShell/AppNavigationPanel";

interface TestStatePatch {
  projects?: Project[];
  selectedProject?: Project;
  workspaces?: Workspace[];
  workspacesByProjectId?: Record<string, Workspace[]>;
  sessionStatuses?: Record<string, SessionStatus>;
  sessionActivities?: Record<string, unknown>;
  sendingPrompts?: Record<string, true>;
  snapshotWorkspaces?: Record<string, StatusFlags>;
}

type SelectionAction = () => void | Promise<void>;
type TransitionStub = (action: SelectionAction, shouldComplete?: () => boolean) => Promise<void>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp jump-to-activity wiring", () => {
  it("jumps to a lit project's workspace: opens the Sessions tab, drills in, and opens its unread session", async () => {
    const projectWorkspaces = { "project-1": [workspace("ws-1", "project-1")] };
    const app = createAppWithState({
      projects: [project("project-1")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      workspacesByProjectId: projectWorkspaces,
      snapshotWorkspaces: { "ws-1": { "core:unread": true } },
    });
    stubTransitions(app);
    const expand = spyOnExpand(app);
    const selectProject = stubProjectSelection(app, projectWorkspaces, { "ws-1": [session("session-1"), session("session-2")] });
    setUnread(app, ["session-2"]);
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-1" });

    expect(expand).toHaveBeenCalledWith("sessions");
    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-1" }), { workspaceId: "ws-1" });
    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-2" }));
  });

  it("opens the in-flight session when none is unread", async () => {
    const projectWorkspaces = { "project-1": [workspace("ws-1", "project-1")] };
    const app = createAppWithState({
      projects: [project("project-1")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      workspacesByProjectId: projectWorkspaces,
      snapshotWorkspaces: { "ws-1": { "core:working": true } },
      sessionStatuses: { "session-1": sessionStatus({ isStreaming: true }) },
    });
    stubTransitions(app);
    stubProjectSelection(app, projectWorkspaces, { "ws-1": [session("session-1"), session("session-2")] });
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-1" });

    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
  });

  it("jumps to a project: drills into its unread workspace from the cached listing", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2"), workspace("ws-b", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      workspacesByProjectId: projectWorkspaces,
      snapshotWorkspaces: { "ws-a": { "core:unread": true }, "ws-b": { "core:working": true } },
    });
    stubTransitions(app);
    const selectProject = stubProjectSelection(app, projectWorkspaces, { "ws-a": [session("session-a1"), session("session-a2")], "ws-b": [session("session-b1")] });
    setUnread(app, ["session-a2"]);
    const expand = spyOnExpand(app);
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(expand).toHaveBeenCalledWith("sessions");
    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-2" }), { workspaceId: "ws-a" });
    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-a2" }));
  });

  it("falls back to the project's own first choice when no workspace of it is lit", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspacesByProjectId: projectWorkspaces,
    });
    stubTransitions(app);
    const selectProject = stubProjectSelection(app, projectWorkspaces, { "ws-a": [] });

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-2" }), undefined);
  });

  it("drills into the lit workspace when the project listing was cold at click time", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2"), workspace("ws-b", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      // workspacesByProjectId is left cold on purpose: after reload only the route-restored
      // project is cached, so an untouched-but-lit project chip must correct course.
      snapshotWorkspaces: { "ws-a": {}, "ws-b": { "core:unread": true } },
    });
    stubTransitions(app);
    stubProjectSelection(app, projectWorkspaces, { "ws-a": [session("session-a1")], "ws-b": [session("session-b1")] });
    const selectWorkspace = stubWorkspaceSelection(app, { "ws-b": [session("session-b1"), session("session-b2")] });
    setUnread(app, ["session-b2"]);
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(selectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-b" }));
    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-b2" }));
  });

  it("cold-cache drill prefers the unread-lit workspace before an in-flight one", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2"), workspace("ws-b", "project-2"), workspace("ws-c", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      // ws-a idle, ws-b in-flight only, ws-c unread: the drill must land on ws-c.
      snapshotWorkspaces: { "ws-a": {}, "ws-b": { "core:working": true }, "ws-c": { "core:unread": true } },
    });
    stubTransitions(app);
    stubProjectSelection(app, projectWorkspaces, { "ws-c": [session("session-c1")] });
    const selectWorkspace = stubWorkspaceSelection(app, { "ws-c": [session("session-c1")] });
    setUnread(app, ["session-c1"]);
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(selectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-c" }));
    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-c1" }));
  });

  it("cold-cache drill lands on an in-flight workspace when nothing is unread", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2"), workspace("ws-b", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      snapshotWorkspaces: { "ws-a": {}, "ws-b": { "core:working": true } },
      sessionStatuses: { "session-b1": sessionStatus({ isStreaming: true }) },
    });
    stubTransitions(app);
    stubProjectSelection(app, projectWorkspaces, { "ws-b": [session("session-b1")] });
    const selectWorkspace = stubWorkspaceSelection(app, { "ws-b": [session("session-b1")] });
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(selectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-b" }));
    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-b1" }));
  });

  it("cold-cache jump keeps the preferred workspace when none of the freshly listed ones is lit", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2"), workspace("ws-b", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
    });
    stubTransitions(app);
    const selectProject = stubProjectSelection(app, projectWorkspaces, { "ws-a": [session("session-a1")], "ws-b": [session("session-b1")] });
    const selectWorkspace = stubWorkspaceSelection(app, { "ws-a": [session("session-a1")], "ws-b": [session("session-b1")] });
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-2" }), undefined);
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("cold-cache jump opens the unread session when the preferred workspace is already lit", async () => {
    const projectWorkspaces = { "project-2": [workspace("ws-a", "project-2"), workspace("ws-b", "project-2")] };
    const app = createAppWithState({
      projects: [project("project-1"), project("project-2")],
      selectedProject: project("project-1"),
      workspaces: [workspace("ws-1", "project-1")],
      // ws-a is both the preferred (first) and the lit workspace: no re-selection needed.
      snapshotWorkspaces: { "ws-a": { "core:unread": true } },
    });
    stubTransitions(app);
    stubProjectSelection(app, projectWorkspaces, { "ws-a": [session("session-a1")], "ws-b": [session("session-b1")] });
    const selectWorkspace = stubWorkspaceSelection(app, { "ws-a": [session("session-a1")] });
    setUnread(app, ["session-a1"]);
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "project-2" });

    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(selectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-a1" }));
  });

  it("ignores a jump whose machine no longer matches the selection", async () => {
    const app = createAppWithState({ projects: [project("project-1")], selectedProject: project("project-1") });
    stubTransitions(app);
    const expand = spyOnExpand(app);
    const selectWorkspace = stubWorkspaceSelection(app, {});
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "remote", projectId: "project-1" });

    expect(expand).not.toHaveBeenCalled();
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("ignores a stale jump whose project is gone", async () => {
    const app = createAppWithState({ projects: [project("project-1")], selectedProject: project("project-1") });
    stubTransitions(app);
    const selectProject = stubProjectSelection(app, {}, {});
    const selectSession = spyOnSelectSession(app);

    await jumpToActivity(app, { machineId: "local", projectId: "ghost" });

    expect(selectProject).not.toHaveBeenCalled();
    expect(selectSession).not.toHaveBeenCalled();
  });
});

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function createAppWithState(patch: TestStatePatch): PiWebApp {
  const app = createApp();
  writeState(app, {
    projects: patch.projects ?? [],
    selectedProject: patch.selectedProject,
    workspaces: patch.workspaces ?? [],
    workspacesByProjectId: patch.workspacesByProjectId ?? {},
    sessions: [],
    sessionStatuses: patch.sessionStatuses ?? {},
    sessionActivities: patch.sessionActivities ?? {},
    sendingPrompts: patch.sendingPrompts ?? {},
    machineStatusSnapshots: { local: machineSnapshot(patch) },
  });
  return app;
}

function machineSnapshot(patch: TestStatePatch) {
  return {
    epochId: "epoch-1",
    revision: 1,
    machine: {},
    projects: {},
    workspaces: patch.snapshotWorkspaces ?? {},
    unattributed: {},
    generatedAt: "2026-06-04T00:00:00.000Z",
  };
}

/**
 * Replaces the private transition plumbing a jump flows through so it runs
 * without a DOM: the scroll transition runs the action directly, and focusing
 * the chat composer is a no-op.
 */
function stubTransitions(app: PiWebApp): void {
  const transition: TransitionStub = async (action: SelectionAction) => { await action(); };
  Reflect.set(app, "withChatScrollTransition", transition);
  Reflect.set(app, "focusChatComposer", () => Promise.resolve());
}

function stubWorkspaceSelection(app: PiWebApp, sessionsByWorkspace: Record<string, SessionInfo[]>) {
  const workspaces = workspacesController(app);
  return vi.spyOn(workspaces, "selectWorkspace").mockImplementation((workspace: Workspace) => {
    writeState(app, { selectedWorkspace: workspace, sessions: sessionsByWorkspace[workspace.id] ?? [] });
    return Promise.resolve();
  });
}

function stubProjectSelection(app: PiWebApp, projectWorkspaces: Record<string, Workspace[]>, sessionsByWorkspace: Record<string, SessionInfo[]>) {
  const workspaces = workspacesController(app);
  return vi.spyOn(workspaces, "selectProject").mockImplementation((project: Project, target?: RouteTarget) => {
    const workspacesForProject = projectWorkspaces[project.id] ?? [];
    const picked = target?.workspaceId === undefined ? workspacesForProject[0] : workspacesForProject.find((workspace) => workspace.id === target.workspaceId);
    writeState(app, {
      selectedProject: project,
      selectedWorkspace: picked,
      workspaces: workspacesForProject,
      sessions: picked === undefined ? [] : (sessionsByWorkspace[picked.id] ?? []),
    });
    return Promise.resolve();
  });
}

function spyOnExpand(app: PiWebApp) {
  const navigationSections: unknown = Reflect.get(app, "navigationSections");
  if (!(navigationSections instanceof NavigationSectionsController)) throw new Error("PiWebApp NavigationSectionsController was unavailable");
  return vi.spyOn(navigationSections, "expand");
}

function spyOnSelectSession(app: PiWebApp) {
  const sessions: unknown = Reflect.get(app, "sessions");
  if (!hasSelectSession(sessions)) throw new Error("PiWebApp SessionController was unavailable");
  return vi.spyOn(sessions, "selectSession").mockResolvedValue(undefined);
}

function hasSelectSession(value: unknown): value is { selectSession(session: SessionInfo): Promise<void> } {
  return typeof value === "object" && value !== null && "selectSession" in value && typeof value.selectSession === "function";
}

function workspacesController(app: PiWebApp): WorkspaceController {
  const workspaces: unknown = Reflect.get(app, "workspaces");
  if (!(workspaces instanceof WorkspaceController)) throw new Error("PiWebApp WorkspaceController was unavailable");
  return workspaces;
}

async function jumpToActivity(app: PiWebApp, item: NavigationActivityItem): Promise<void> {
  const jump: unknown = Reflect.get(app, "jumpToActivity");
  if (typeof jump !== "function") throw new Error("PiWebApp.jumpToActivity is not callable");
  await jump.call(app, item);
}

function setUnread(app: PiWebApp, ids: string[]): void {
  Reflect.set(app, "unreadSessionIds", new Set(ids));
}

function writeState(app: PiWebApp, patch: Record<string, unknown>): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("PiWebApp state was unavailable");
  Reflect.set(app, "state", { ...state, ...patch });
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

function session(id: string): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: `/repo/${id}`,
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}

function workspace(id: string, projectId: string): Workspace {
  return { id, projectId, path: `/repo/${id}`, label: id, isMain: true, effectiveConfig: {} };
}
