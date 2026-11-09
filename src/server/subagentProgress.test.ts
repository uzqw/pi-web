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
