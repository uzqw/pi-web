import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunProgress } from "../shared/apiTypes.js";
import { buildApp } from "./app.js";
import { findRunDir, listSessionSubagentRuns, readSubagentProgress } from "./subagentProgress.js";

const RUN_ID = "2f1d3c4b-5a69-4b7c-8d90-1a2b3c4d5e6f";
const UNKNOWN_RUN_ID = "00000000-0000-4000-8000-000000000000";

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "pi-web-subagent-progress-test-"));
});

afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true });
});

describe("subagent run discovery", () => {
  it("finds a run directory only for UUID-shaped ids that have a status file", async () => {
    await writeRun({ status: { state: "running" } });

    await expect(findRunDir(RUN_ID, { runsRoot })).resolves.toBe(join(runsRoot, "pi-subagents-test", "async-subagent-runs", RUN_ID));
    await expect(findRunDir(UNKNOWN_RUN_ID, { runsRoot })).resolves.toBeUndefined();
    // Path-shaped ids never reach the filesystem, so a client cannot name a directory.
    for (const runId of ["../async-subagent-runs", "/etc/passwd", "..%2F..%2Fetc", "2f1d3c4b-5a69-4b7c-8d90-1a2b3c4d5e6"]) {
      await expect(findRunDir(runId, { runsRoot })).resolves.toBeUndefined();
    }
    await expect(readSubagentProgress(UNKNOWN_RUN_ID, { runsRoot })).resolves.toBeUndefined();
  });
});

describe("session subagent runs", () => {
  const SESSION_ID = "01a1be00-f5a5-72bd-ac21-7c0d810e482f";

  it("lists only the runs whose status names this session, newest first", async () => {
    const sessionFile = `/home/someone/.pi/agent/sessions/--work--/2026-11-09T01-51-36-357Z_${SESSION_ID}.jsonl`;
    const otherFile = "/home/someone/.pi/agent/sessions/--work--/2026-11-09T02-00-00-000Z_ffffffff-0000-4000-8000-000000000000.jsonl";
    await writeRunAt("aaaaaaaa-0000-4000-8000-000000000001", { runId: "aaaaaaaa-0000-4000-8000-000000000001", sessionId: sessionFile, mode: "workflow", state: "running", startedAt: 1_000, steps: [{ label: "scoring", status: "running", startedAt: 1_000 }] });
    await writeRunAt("aaaaaaaa-0000-4000-8000-000000000002", { runId: "aaaaaaaa-0000-4000-8000-000000000002", sessionId: sessionFile, mode: "single", state: "completed", startedAt: 5_000, endedAt: 6_000, steps: [{ label: "scout", status: "completed", startedAt: 5_000, endedAt: 6_000 }] });
    await writeRunAt("aaaaaaaa-0000-4000-8000-000000000003", { runId: "aaaaaaaa-0000-4000-8000-000000000003", sessionId: otherFile, mode: "single", state: "running", startedAt: 9_000 });

    const runs = await listSessionSubagentRuns(SESSION_ID, { runsRoot, now: () => 7_000 });

    expect(runs.map((run) => run.runId)).toEqual(["aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001"]);
    expect(runs.map((run) => run.mode)).toEqual(["single", "workflow"]);
    expect(runs[1]?.children[0]?.label).toBe("scoring");
    expect(runs[0]?.totalMs).toBe(1_000);
  });

  it("ignores a session id that is not UUID-shaped", async () => {
    await writeRunAt("aaaaaaaa-0000-4000-8000-000000000004", { runId: "aaaaaaaa-0000-4000-8000-000000000004", sessionId: "/tmp/sessions/../etc/passwd", mode: "single", state: "running", startedAt: 1_000 });

    await expect(listSessionSubagentRuns("../etc/passwd", { runsRoot })).resolves.toEqual([]);
    await expect(listSessionSubagentRuns("aaaaaaaa-0000-4000-8000-00000000000", { runsRoot })).resolves.toEqual([]);
  });
});

describe("polling under a growing history", () => {
  const SESSION_ID = "01a1be00-f5a5-72bd-ac21-7c0d810e482f";
  const OTHER_SESSION_FILE = "/sessions/2026-11-09T02-00-00-000Z_ffffffff-0000-4000-8000-000000000000.jsonl";
  const sessionFile = `/sessions/2026-11-09T01-51-36-357Z_${SESSION_ID}.jsonl`;

  it("picks up a run directory that appears after a previous listing", async () => {
    await writeRunAt("bbbbbbbb-0000-4000-8000-000000000001", { runId: "bbbbbbbb-0000-4000-8000-000000000001", sessionId: sessionFile, mode: "single", state: "running", startedAt: 1_000 });
    expect((await listSessionSubagentRuns(SESSION_ID, { runsRoot })).map((run) => run.runId)).toEqual(["bbbbbbbb-0000-4000-8000-000000000001"]);

    // The group directory's mtime is what tells the listing cache a dispatch started.
    await writeRunAt("bbbbbbbb-0000-4000-8000-000000000002", { runId: "bbbbbbbb-0000-4000-8000-000000000002", sessionId: sessionFile, mode: "single", state: "running", startedAt: 2_000 });
    expect((await listSessionSubagentRuns(SESSION_ID, { runsRoot })).map((run) => run.runId))
      .toEqual(["bbbbbbbb-0000-4000-8000-000000000002", "bbbbbbbb-0000-4000-8000-000000000001"]);
  });

  it("still reflects a rewritten status file for a run it already knows", async () => {
    const runDir = await writeRunAt("bbbbbbbb-0000-4000-8000-000000000003", { runId: "bbbbbbbb-0000-4000-8000-000000000003", sessionId: sessionFile, mode: "workflow", state: "running", startedAt: 1_000, steps: [{ label: "ui", status: "running", startedAt: 1_000 }] });
    expect((await listSessionSubagentRuns(SESSION_ID, { runsRoot }))[0]?.state).toBe("running");

    await writeFile(join(runDir, "status.json"), JSON.stringify({ runId: "bbbbbbbb-0000-4000-8000-000000000003", sessionId: sessionFile, mode: "workflow", state: "completed", startedAt: 1_000, endedAt: 4_000, steps: [{ label: "ui", status: "completed", startedAt: 1_000, endedAt: 4_000 }] }), "utf8");
    expect((await listSessionSubagentRuns(SESSION_ID, { runsRoot }))[0]?.state).toBe("completed");
  });

  it("reads a finished run's parent session once and keeps filtering from memory", async () => {
    const runDir = await writeRunAt("bbbbbbbb-0000-4000-8000-000000000004", { runId: "bbbbbbbb-0000-4000-8000-000000000004", sessionId: OTHER_SESSION_FILE, mode: "single", state: "completed", startedAt: 1_000, endedAt: 2_000 });
    expect(await listSessionSubagentRuns(SESSION_ID, { runsRoot })).toEqual([]);

    // Repointing a finished run at this session is not something the runtime does, but
    // it is the only way to observe whether the second poll read the file at all: the
    // answer stays "not this session", so the parent came from memory.
    await writeFile(join(runDir, "status.json"), JSON.stringify({ runId: "bbbbbbbb-0000-4000-8000-000000000004", sessionId: sessionFile, mode: "single", state: "completed", startedAt: 1_000, endedAt: 2_000 }), "utf8");
    expect(await listSessionSubagentRuns(SESSION_ID, { runsRoot })).toEqual([]);
  });

  it("answers 304 for a finished run's unchanged answer and 200 once it moves", async () => {
    const sessionFileForRun = `/sessions/2026-11-09T01-51-36-357Z_${SESSION_ID}.jsonl`;
    const doneId = "bbbbbbbb-0000-4000-8000-000000000006";
    const runDir = await writeRunAt(doneId, { runId: doneId, sessionId: sessionFileForRun, mode: "single", state: "completed", startedAt: 1_000, endedAt: 2_000, steps: [] });
    const app = await buildApp({
      sessionDaemon: { request: () => Promise.reject(new Error("sessiond is offline")), requestStream: () => Promise.reject(new Error("sessiond is offline")), connectWebSocket: () => { throw new Error("sessiond is offline"); } },
      subagentRunsRoot: runsRoot,
      clientDist: false,
      logger: false,
    });
    const dock = "/api/subagent-runs?sessionId=" + SESSION_ID + "&machineId=local";

    try {
      const first = await app.inject({ method: "GET", url: dock });
      const etag = String(first.headers.etag);
      expect(first.headers["cache-control"]).toBe("no-cache");

      const unchanged = await app.inject({ method: "GET", url: dock, headers: { "if-none-match": etag } });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe("");

      await writeFile(join(runDir, "status.json"), JSON.stringify({ runId: doneId, sessionId: sessionFileForRun, mode: "single", state: "completed", startedAt: 1_000, endedAt: 3_000, steps: [] }), "utf8");
      const changed = await app.inject({ method: "GET", url: dock, headers: { "if-none-match": etag } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ supported: true, runs: [{ state: "completed", totalMs: 2_000 }] });

      const card = await app.inject({ method: "GET", url: `/api/subagent-runs/${doneId}/progress` });
      const cachedCard = await app.inject({ method: "GET", url: `/api/subagent-runs/${doneId}/progress`, headers: { "if-none-match": String(card.headers.etag) } });
      expect(cachedCard.statusCode).toBe(304);
      expect(cachedCard.body).toBe("");
    } finally {
      await app.close();
    }
  });

  it("never answers 304 for a live run, whose elapsed time moves every poll", async () => {
    const liveId = "bbbbbbbb-0000-4000-8000-000000000007";
    await writeRunAt(liveId, { runId: liveId, sessionId: `/sessions/2026-11-09T01-51-36-357Z_${SESSION_ID}.jsonl`, mode: "single", state: "running", startedAt: 1_000, steps: [{ label: "scout", status: "running", startedAt: 1_000 }] });
    const app = await buildApp({
      sessionDaemon: { request: () => Promise.reject(new Error("sessiond is offline")), requestStream: () => Promise.reject(new Error("sessiond is offline")), connectWebSocket: () => { throw new Error("sessiond is offline"); } },
      subagentRunsRoot: runsRoot,
      clientDist: false,
      logger: false,
    });

    try {
      const first = await app.inject({ method: "GET", url: `/api/subagent-runs/${liveId}/progress` });
      const again = await app.inject({ method: "GET", url: `/api/subagent-runs/${liveId}/progress`, headers: { "if-none-match": String(first.headers.etag) } });
      expect(again.statusCode).toBe(200);
      expect(again.json<SubagentRunProgress>().children[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });
});

describe("subagent run progress", () => {
  it("reports per-lane tools, output and timing from both session log shapes", async () => {
    const transcriptLane = await writeSessionLog(`${RUN_ID}-scoring.jsonl`, [
      JSON.stringify({ recordType: "message", role: "assistant", text: "## Plan\n\n- Reading `ToolExecutionView.ts` now" }),
      JSON.stringify({ recordType: "tool_start", toolName: "read" }),
      JSON.stringify({ recordType: "tool_end", toolName: "read", isError: false }),
      JSON.stringify({ recordType: "tool_start", toolName: "bash" }),
      JSON.stringify({ recordType: "tool_end", toolName: "bash", isError: true }),
    ]);
    const sessionLane = await writeSessionLog(`${RUN_ID}-ui.jsonl`, [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Added the progress card." }, { type: "toolCall", name: "write" }] } }),
    ]);
    await writeRun({
      status: {
        runId: RUN_ID,
        mode: "workflow",
        state: "running",
        startedAt: 1_000,
        lastUpdate: 2_500,
        steps: [
          { agent: "worker", label: "scoring", workflowKey: "scoring", status: "running", startedAt: 1_000, sessionFile: transcriptLane },
          { agent: "worker", label: "ui", workflowKey: "ui", status: "failed", startedAt: 1_200, endedAt: 1_900, sessionFile: sessionLane },
          { agent: "worker", label: "no log yet", workflowKey: "no-log", status: "running", startedAt: 1_100 },
        ],
      },
    });

    const progress = await readSubagentProgress(RUN_ID, { runsRoot, now: () => 4_000 });

    expect(progress).toEqual({
      runId: RUN_ID,
      state: "running",
      startedAt: 1_000,
      updatedAt: 2_500,
      totalMs: 3_000,
      children: [
        { key: "scoring", label: "scoring", agent: "worker", status: "running", startedAt: 1_000, elapsedMs: 3_000, toolCount: 2, lastTool: "bash", lastText: "Reading ToolExecutionView.ts now", isError: true },
        { key: "ui", label: "ui", agent: "worker", status: "failed", startedAt: 1_200, elapsedMs: 700, toolCount: 1, lastTool: "write", lastText: "Added the progress card." },
        { key: "no-log", label: "no log yet", agent: "worker", status: "running", startedAt: 1_100, elapsedMs: 2_900, toolCount: 0 },
      ],
    });
  });

  it("maps the runtime's completed state and derives a finished lane's elapsed time from its log", async () => {
    const sessionFile = await writeSessionLog(`${RUN_ID}-complete.jsonl`, [
      JSON.stringify({ recordType: "tool_end", toolName: "read", isError: false }),
    ]);
    // A finished lane that never stored an end stamp falls back to the last write.
    await utimes(sessionFile, new Date(5_000), new Date(5_000));
    await writeRun({
      status: {
        state: "complete",
        startedAt: 1_000,
        endedAt: 9_000,
        steps: [{ agent: "worker", label: "scoring", workflowKey: "scoring", status: "complete", startedAt: 1_000, sessionFile }],
      },
    });

    const progress = await readSubagentProgress(RUN_ID, { runsRoot, now: () => 20_000 });

    expect(progress).toMatchObject({ state: "completed", totalMs: 8_000 });
    expect(progress?.children).toEqual([
      { key: "scoring", label: "scoring", agent: "worker", status: "completed", startedAt: 1_000, elapsedMs: 4_000, toolCount: 0, lastTool: "read", isError: false },
    ]);
  });

  it("degrades to empty fields when the status file is unreadable or a session log is missing", async () => {
    await writeRun({ statusText: "{ not json" });

    await expect(readSubagentProgress(RUN_ID, { runsRoot })).resolves.toEqual({ runId: RUN_ID, state: "running", children: [] });

    await writeRun({
      status: {
        state: "running",
        startedAt: 1_000,
        steps: [
          { agent: "worker", label: "gone", workflowKey: "gone", status: "running", startedAt: 1_000, sessionFile: join(runsRoot, "missing", "session.jsonl") },
          { agent: "worker", label: "unnamed" },
        ],
      },
    });

    await expect(readSubagentProgress(RUN_ID, { runsRoot, now: () => 2_000 })).resolves.toMatchObject({
      children: [
        { key: "gone", label: "gone", agent: "worker", status: "running", elapsedMs: 1_000, toolCount: 0 },
        { key: "step-1", label: "unnamed", agent: "worker", status: "running", toolCount: 0 },
      ],
    });
  });

  it("reads only the tail window of a session log", async () => {
    const sessionFile = await writeSessionLog(`${RUN_ID}-oversized.jsonl`, [
      JSON.stringify({ recordType: "tool_start", toolName: "bash" }),
      JSON.stringify({ recordType: "message", role: "assistant", text: "x".repeat(300_000) }),
      JSON.stringify({ recordType: "tool_start", toolName: "read" }),
    ]);
    await writeRun({
      status: { state: "running", startedAt: 1_000, steps: [{ agent: "worker", label: "big", status: "running", startedAt: 1_000, sessionFile }] },
    });

    const progress = await readSubagentProgress(RUN_ID, { runsRoot, now: () => 2_000 });

    // The newest records survive the 256 KB window; the oldest and the partial
    // first line of the window are not counted.
    expect(progress?.children[0]).toMatchObject({ toolCount: 1, lastTool: "read" });
  });

  it("keeps a run whose status file exceeds the read budget, marked oversized", async () => {
    await writeRun({ statusText: JSON.stringify({ state: "running", startedAt: 1_000, steps: [], filler: "x".repeat(2 * 1024 * 1024) }) });

    const progress = await readSubagentProgress(RUN_ID, { runsRoot, now: () => 2_000 });

    // A run that cannot be described in full is still a run: dropping it would make the
    // dispatch card look like nothing was ever started.
    expect(progress).toMatchObject({ runId: RUN_ID, state: "running", children: [], statusOversized: true });
  });

  it("does not re-read session logs while the status file is unchanged", async () => {
    const sessionFile = await writeSessionLog(`${RUN_ID}-memo.jsonl`, [
      JSON.stringify({ recordType: "tool_start", toolName: "read" }),
    ]);
    const status = { state: "running", startedAt: 1_000, steps: [{ label: "one", status: "running", startedAt: 1_000, sessionFile }] };
    await writeRun({ status });

    await expect(readSubagentProgress(RUN_ID, { runsRoot, now: () => 2_000 })).resolves.toMatchObject({
      children: [{ toolCount: 1, lastTool: "read", elapsedMs: 1_000 }],
    });

    // The lane log is gone, yet the answer still reports it: an unchanged status file
    // costs one stat, not another parse and log read. Only the clock keeps moving.
    await rm(sessionFile);
    await expect(readSubagentProgress(RUN_ID, { runsRoot, now: () => 3_000 })).resolves.toMatchObject({
      children: [{ toolCount: 1, lastTool: "read", elapsedMs: 2_000 }],
    });

    // A fresh status write invalidates it.
    const statusFile = join(runsRoot, "pi-subagents-test", "async-subagent-runs", RUN_ID, "status.json");
    await writeFile(statusFile, JSON.stringify(status), "utf8");
    await utimes(statusFile, new Date(9_000), new Date(9_000));
    await expect(readSubagentProgress(RUN_ID, { runsRoot, now: () => 3_000 })).resolves.toMatchObject({
      children: [{ toolCount: 0 }],
    });
  });

  it("keeps lane order when a run has more lanes than the read fan-out", async () => {
    const steps = Array.from({ length: 12 }, (_unused, index) => ({ label: `lane ${String(index)}`, workflowKey: `lane-${String(index)}`, status: "running", startedAt: 1_000 }));
    await writeRun({ status: { state: "running", startedAt: 1_000, steps } });

    const progress = await readSubagentProgress(RUN_ID, { runsRoot, now: () => 2_000 });

    expect(progress?.children.map((child) => child.key)).toEqual(Array.from({ length: 12 }, (_unused, index) => `lane-${String(index)}`));
  });
});

describe("GET /api/subagent-runs/:runId/progress", () => {
  it("serves progress locally instead of forwarding it to the session daemon", async () => {
    const sessionFile = await writeSessionLog(`${RUN_ID}-app.jsonl`, [
      JSON.stringify({ recordType: "tool_start", toolName: "read" }),
    ]);
    await writeRun({
      status: { state: "running", startedAt: 1_000, lastUpdate: 1_500, steps: [{ agent: "worker", label: "ui", workflowKey: "ui", status: "running", startedAt: 1_000, sessionFile }] },
    });
    const request = vi.fn(() => Promise.reject(new Error("sessiond is offline")));
    const app = await buildApp({
      sessionDaemon: { request, requestStream: () => Promise.reject(new Error("sessiond is offline")), connectWebSocket: () => { throw new Error("sessiond is offline"); } },
      subagentRunsRoot: runsRoot,
      clientDist: false,
      logger: false,
    });

    try {
      const response = await app.inject({ method: "GET", url: `/api/subagent-runs/${RUN_ID}/progress` });

      expect(response.statusCode).toBe(200);
      expect(response.json<SubagentRunProgress>()).toMatchObject({
        runId: RUN_ID,
        state: "running",
        children: [{ key: "ui", label: "ui", status: "running", toolCount: 1, lastTool: "read" }],
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("answers 404 for unknown and malformed run ids without proxying", async () => {
    const request = vi.fn(() => Promise.reject(new Error("sessiond is offline")));
    const app = await buildApp({
      sessionDaemon: { request, requestStream: () => Promise.reject(new Error("sessiond is offline")), connectWebSocket: () => { throw new Error("sessiond is offline"); } },
      subagentRunsRoot: runsRoot,
      clientDist: false,
      logger: false,
    });

    try {
      for (const runId of [UNKNOWN_RUN_ID, "..%2Fasync-subagent-runs"]) {
        const response = await app.inject({ method: "GET", url: `/api/subagent-runs/${runId}/progress` });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Subagent run not found" });
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("answers the dock for the local machine and refuses another machine's session", async () => {
    const sessionFile = `/home/someone/.pi/agent/sessions/--work--/2026-11-09T01-51-36-357Z_aaaaaaaa-0000-4000-8000-000000000001.jsonl`;
    await writeRunAt("aaaaaaaa-0000-4000-8000-000000000001", { runId: "aaaaaaaa-0000-4000-8000-000000000001", sessionId: sessionFile, mode: "single", state: "running", startedAt: 1_000 });
    const app = await buildApp({
      sessionDaemon: { request: () => Promise.reject(new Error("sessiond is offline")), requestStream: () => Promise.reject(new Error("sessiond is offline")), connectWebSocket: () => { throw new Error("sessiond is offline"); } },
      subagentRunsRoot: runsRoot,
      clientDist: false,
      logger: false,
    });

    try {
      const local = await app.inject({ method: "GET", url: "/api/subagent-runs?sessionId=aaaaaaaa-0000-4000-8000-000000000001&machineId=local" });
      expect(local.json()).toMatchObject({ supported: true, runs: [{ runId: "aaaaaaaa-0000-4000-8000-000000000001", mode: "single" }] });
      // A client written before machines existed still means this host.
      const withoutMachine = await app.inject({ method: "GET", url: "/api/subagent-runs?sessionId=aaaaaaaa-0000-4000-8000-000000000001" });
      expect(withoutMachine.json()).toMatchObject({ supported: true });

      // An empty list here would read as "nothing is running" on a host that cannot see
      // the session's temp directory at all.
      const remote = await app.inject({ method: "GET", url: "/api/subagent-runs?sessionId=aaaaaaaa-0000-4000-8000-000000000001&machineId=other-host" });
      expect(remote.statusCode).toBe(200);
      expect(remote.json()).toEqual({ supported: false, machineId: "other-host" });
    } finally {
      await app.close();
    }
  });
});

async function writeRunAt(runId: string, status: unknown): Promise<string> {
  const runDir = join(runsRoot, "pi-subagents-test", "async-subagent-runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "status.json"), JSON.stringify(status), "utf8");
  return runDir;
}

async function writeRun(options: { status?: unknown; statusText?: string }): Promise<string> {
  const runDir = join(runsRoot, "pi-subagents-test", "async-subagent-runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  const statusText = options.statusText ?? JSON.stringify(options.status);
  await writeFile(join(runDir, "status.json"), statusText, "utf8");
  return runDir;
}

async function writeSessionLog(name: string, lines: readonly string[]): Promise<string> {
  const dir = join(runsRoot, "sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}
