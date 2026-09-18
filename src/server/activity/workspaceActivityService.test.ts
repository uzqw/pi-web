import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../shared/apiTypes";
import { WorkspaceActivityService } from "./workspaceActivityService";

function status(patch: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...patch,
  };
}

/** The service under test plus the change notifications it reported. */
function activityRecord() {
  const onChanged = vi.fn();
  return { service: new WorkspaceActivityService(onChanged), onChanged };
}

describe("WorkspaceActivityService", () => {
  it("records session activity by cwd and reports every projected change", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionStatus("/repo", status({ isStreaming: true }));

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false }]);
    expect(onChanged).toHaveBeenCalledTimes(1);

    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(service.snapshot().workspaces).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("reports per-token status republishes only once while the session stays active", () => {
    const { service, onChanged } = activityRecord();

    // A streaming turn republishes status for every token delta. The projected
    // activity is unchanged, so the machine-status projection must not be
    // recomputed once per token (that recomputation re-resolves the workspace
    // topology of every project).
    for (let token = 0; token < 40; token++) {
      service.applySessionStatus("/repo", status({ isStreaming: true, messageCount: 10, tokens: { input: token, output: token, cacheRead: 0, cacheWrite: 0, total: token * 2 } }));
    }

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true }]);

    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("reports mid-turn activity labels only when the projected activity changes", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "t1" });

    expect(onChanged).toHaveBeenCalledTimes(1);

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "write", at: "t2" });
    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "receiving response", at: "t3" });

    expect(onChanged).toHaveBeenCalledTimes(1);

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "idle", label: "idle", at: "t4" });

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(service.snapshot().workspaces).toEqual([]);
  });

  it("reports a workspace move for a session that stays active", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionStatus("/repo", status({ isStreaming: true }));
    onChanged.mockClear();

    service.applySessionStatus("/worktree", status({ isStreaming: true }));

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/worktree", hasSessionActivity: true }]);
  });

  it("does not report a workspace active for a session that is only starting up", () => {
    const { service, onChanged } = activityRecord();

    // Startup progress names a phase the daemon is inside; it is not work, so the
    // workspace (and the project indicators and remote machines that read it)
    // must not be reported as busy because of it. Startup progress is not part of
    // the projection, so it is not a projected change either.
    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "Opening session", detail: "Starting the Pi session", at: "now", startup: true });

    expect(service.snapshot().workspaces).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("clears stale active activity when an idle status arrives", () => {
    const { service } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "now" });
    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(service.snapshot().workspaces).toEqual([]);
  });

  it("reports a change when removing an already-pruned session with a cwd", () => {
    const { service, onChanged } = activityRecord();

    service.removeSession("missing-session", "/repo");

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reconciles stale session activity for a workspace", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", at: "now" });
    service.applySessionActivity("/repo", { sessionId: "s2", phase: "active", label: "running tool", at: "now" });
    service.applySessionActivity("/other", { sessionId: "s3", phase: "active", label: "running tool", at: "now" });
    onChanged.mockClear();

    service.reconcileSessionActivity("/repo", ["s2"]);

    expect(service.snapshot().workspaces).toMatchObject([
      { cwd: "/other", hasSessionActivity: true, hasTerminalActivity: false },
      { cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false },
    ]);

    service.reconcileSessionActivity("/repo", []);

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/other", hasSessionActivity: true, hasTerminalActivity: false }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("combines sessions and terminals and clears closed terminals", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "now" });
    service.updateTerminal({ id: "t1", cwd: "/repo", exited: false });

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: true }]);

    service.removeSession("s1");
    service.updateTerminal({ id: "t1", cwd: "/repo", exited: true });

    expect(service.snapshot().workspaces).toEqual([]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("records activity without a listener, so a store built for a test still works", () => {
    const service = new WorkspaceActivityService();

    service.updateTerminal({ id: "t1", cwd: "/repo", exited: false });

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasTerminalActivity: true }]);
  });
});
