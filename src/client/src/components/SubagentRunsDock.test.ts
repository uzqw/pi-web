// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSubagentRunsResponse } from "../../../shared/apiTypes";
import "./SubagentRunsDock";
import { SubagentRunsDock } from "./SubagentRunsDock";

const SESSION_ID = "01a1be00-f5a5-72bd-ac21-7c0d810e482f";
const RUN_ID = "2f1d3c4b-5a69-4b7c-8d90-1a2b3c4d5e6f";
const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  document.body.replaceChildren();
  globalThis.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subagent runs dock", () => {
  it("lists the session's runs above the composer and keeps polling while one is live", async () => {
    const fetchMock = stubSequenceFetch([runsResponse("running"), runsResponse("completed")]);
    const dock = mount(SESSION_ID);
    await settle(dock);

    expect(headText(dock)).toBe("Subtasks · 1 run · 1 running");
    expect(laneRows(dock)).toEqual([
      ["running", "scoring", "2.0s", "bash", "Reading ToolExecutionView.ts now"],
      ["completed", "ui", "1.0s", "write", "Added the progress card."],
    ]);
    expect(new URL(requestUrl(fetchMock, 0)).searchParams.get("sessionId")).toBe(SESSION_ID);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle(dock);

    expect(headText(dock)).toBe("Subtasks · 1 run · done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders nothing for a session without recent runs", async () => {
    stubSequenceFetch([{ runs: [] }]);
    const dock = mount(SESSION_ID);
    await settle(dock);

    expect(dock.renderRoot.querySelector(".dock")).toBeNull();
  });

  it("collapses to a single summary line and remembers the choice", async () => {
    stubSequenceFetch([runsResponse("running")]);
    const dock = mount(SESSION_ID);
    await settle(dock);
    expect(dock.renderRoot.querySelectorAll(".dock-run").length).toBe(1);

    toggle(dock);
    await settle(dock);

    expect(dock.renderRoot.querySelector(".dock-body")).toBeNull();
    expect(headText(dock)).toBe("Subtasks · 1 run · 1 running");
    expect(globalThis.localStorage.getItem("pi-web.subagent-runs-dock.collapsed")).toBe("1");

    // A fresh mount honours the stored choice.
    const reopened = mount(SESSION_ID);
    await settle(reopened);
    expect(reopened.renderRoot.querySelector(".dock-body")).toBeNull();
  });

  it("drops a run that finished long ago", async () => {
    const stale = runsResponse("completed");
    const onlyRun = stale.runs[0];
    if (onlyRun === undefined) throw new Error("fixture run missing");
    onlyRun.updatedAt = NOW - 30 * 60 * 1_000;
    stubSequenceFetch([stale]);
    const dock = mount(SESSION_ID);
    await settle(dock);

    expect(dock.renderRoot.querySelector(".dock")).toBeNull();
  });
});

function runsResponse(liveState: "running" | "completed"): SessionSubagentRunsResponse {
  return {
    runs: [
      {
        runId: RUN_ID,
        mode: "workflow",
        state: liveState,
        startedAt: NOW - 4_000,
        updatedAt: NOW,
        ...(liveState === "completed" ? { totalMs: 4_000 } : {}),
        children: [
          { key: "scoring", label: "scoring", agent: "worker", status: liveState, elapsedMs: 2_000, toolCount: 4, lastTool: "bash", lastText: "Reading ToolExecutionView.ts now" },
          { key: "ui", label: "ui", agent: "worker", status: "completed", elapsedMs: 1_000, toolCount: 2, lastTool: "write", lastText: "Added the progress card." },
        ],
      },
    ],
  };
}

function mount(sessionId: string): SubagentRunsDock {
  const dock = new SubagentRunsDock();
  dock.sessionId = sessionId;
  dock.hasAsyncDispatches = true;
  document.body.append(dock);
  return dock;
}

function toggle(dock: SubagentRunsDock): void {
  const button = dock.renderRoot.querySelector<HTMLButtonElement>(".dock-head");
  if (button === null) throw new Error("Expected dock header button");
  button.click();
}

function headText(dock: SubagentRunsDock): string {
  return dock.renderRoot.querySelector(".dock-title")?.textContent.trim() ?? "";
}

function laneRows(dock: SubagentRunsDock): string[][] {
  return [...dock.renderRoot.querySelectorAll(".lane")].map((lane) => [
    lane.classList[1] ?? "",
    lane.querySelector(".lane-label")?.textContent ?? "",
    lane.querySelector(".lane-elapsed")?.textContent ?? "",
    lane.querySelector(".lane-tool")?.textContent ?? "",
    lane.querySelector(".lane-text")?.textContent ?? "",
  ]);
}

async function settle(dock: SubagentRunsDock): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    await dock.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
  }
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function stubSequenceFetch(responses: unknown[]): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => {
    const response = responses.shift();
    if (response === undefined) throw new Error("No fetch response queued");
    return Promise.resolve(jsonResponse(response));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function requestUrl(fetchMock: FetchMock, index: number): string {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`No fetch call at index ${String(index)}`);
  const url = call[0];
  if (typeof url === "string") return url;
  return url instanceof URL ? url.toString() : url.url;
}
