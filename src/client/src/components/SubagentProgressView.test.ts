// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunProgress } from "../../../shared/apiTypes";
import type { ChatLine, ToolExecutionPart } from "./shared";
import { groupShowsAsyncSubagent } from "./ChatView";
import { SubagentProgressView, asyncSubagentRunId, subagentElapsedLabel } from "./SubagentProgressView";

const RUN_ID = "2f1d3c4b-5a69-4b7c-8d90-1a2b3c4d5e6f";
const POLL_INTERVAL_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subagent progress view", () => {
  it("renders one row per lane and polls until the run reaches a terminal state", async () => {
    const fetchMock = stubSequenceFetch([jsonResponse(runningSnapshot()), jsonResponse(completedSnapshot())]);
    const view = mount(RUN_ID);
    await settle(view);

    expect(header(view)).toEqual(["Subtasks · 2", "running"]);
    expect(lanes(view)).toEqual([
      ["running", "scoring", "2.0s", "bash", "Reading ToolExecutionView.ts now"],
      ["completed", "ui", "0.7s", "write", "Added the progress card."],
    ]);
    expect(new URL(requestUrl(fetchMock, 0)).pathname).toBe(`/api/subagent-runs/${RUN_ID}/progress`);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await settle(view);

    expect(header(view)).toEqual(["Subtasks · 2", "completed"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A finished run is not polled again.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await settle(view);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the async run id off a subagent card and ignores foreground calls", () => {
    const part = (toolName: string, details?: unknown): ToolExecutionPart => ({
      type: "toolExecution",
      toolName,
      summary: "",
      status: "success",
      ...(details === undefined ? {} : { details }),
    });

    expect(asyncSubagentRunId(part("subagent", { asyncId: RUN_ID }))).toBe(RUN_ID);
    expect(asyncSubagentRunId(part("subagent", { asyncId: "" }))).toBeUndefined();
    expect(asyncSubagentRunId(part("subagent", { mode: "single", results: [] }))).toBeUndefined();
    expect(asyncSubagentRunId(part("subagent"))).toBeUndefined();
    expect(asyncSubagentRunId(part("bash", { asyncId: RUN_ID }))).toBeUndefined();
  });

  it("opens a collapsed event group when it holds an async subagent dispatch", () => {
    const line = (part: ToolExecutionPart): ChatLine => ({ role: "tool", parts: [part] });
    const asyncDispatch: ToolExecutionPart = { type: "toolExecution", toolName: "subagent", summary: "", status: "success", details: { asyncId: RUN_ID } };
    const foregroundCall: ToolExecutionPart = { type: "toolExecution", toolName: "subagent", summary: "", status: "success", details: { mode: "single" } };
    const bashCall: ToolExecutionPart = { type: "toolExecution", toolName: "bash", summary: "", status: "success" };

    expect(groupShowsAsyncSubagent([line(asyncDispatch)])).toBe(true);
    expect(groupShowsAsyncSubagent([line(foregroundCall), line(bashCall)])).toBe(false);
    expect(groupShowsAsyncSubagent([])).toBe(false);
  });

  it("encodes the run id as a single path segment", async () => {
    const fetchMock = stubSequenceFetch([jsonResponse(runningSnapshot())]);
    const view = mount("run/../other");
    await settle(view);

    expect(new URL(requestUrl(fetchMock, 0)).pathname).toBe("/api/subagent-runs/run%2F..%2Fother/progress");
  });

  it("renders nothing and stops polling when the host has no such run", async () => {
    const fetchMock = stubSequenceFetch([notFoundResponse()]);
    const view = mount(RUN_ID);
    await settle(view);

    expect(view.renderRoot.querySelector(".subagent-progress")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await settle(view);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps sub-minute lane times in tenths and switches to minutes after a minute", () => {
    expect(subagentElapsedLabel(3_000)).toBe("3.0s");
    expect(subagentElapsedLabel(65_400)).toBe("1m 5s");
  });

  it("renders nothing for an empty lane list instead of an empty frame", async () => {
    stubSequenceFetch([jsonResponse({ runId: RUN_ID, state: "running", children: [] })]);
    const view = mount(RUN_ID);
    await settle(view);

    expect(view.renderRoot.querySelector(".subagent-progress")).toBeNull();
  });

  it("stops polling when the element leaves the document", async () => {
    const fetchMock = stubSequenceFetch([jsonResponse(runningSnapshot()), jsonResponse(runningSnapshot())]);
    const view = mount(RUN_ID);
    await settle(view);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.remove();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await settle(view);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function mount(runId: string): SubagentProgressView {
  const view = new SubagentProgressView();
  view.runId = runId;
  document.body.append(view);
  return view;
}

async function settle(view: SubagentProgressView): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await view.updateComplete;
}

function header(view: SubagentProgressView): string[] {
  return [text(view.renderRoot, ".subagent-header > span:first-child"), text(view.renderRoot, ".subagent-state")];
}

function lanes(view: SubagentProgressView): string[][] {
  return [...view.renderRoot.querySelectorAll(".subagent-lane")].map((lane) => [
    text(lane, ".sr-only"),
    text(lane, ".lane-label"),
    text(lane, ".lane-elapsed"),
    text(lane, ".lane-tool"),
    text(lane, ".lane-text"),
  ]);
}

function text(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent.trim() ?? "";
}

function requestUrl(fetchMock: FetchMock, index: number): string {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${String(index)}`);
  const [url] = call;
  if (typeof url === "string") return url;
  return url instanceof URL ? url.toString() : url.url;
}

function runningSnapshot(): SubagentRunProgress {
  return {
    runId: RUN_ID,
    state: "running",
    startedAt: 1_000,
    updatedAt: 3_000,
    totalMs: 2_000,
    children: [
      { key: "scoring", label: "scoring", agent: "worker", status: "running", startedAt: 1_000, elapsedMs: 2_000, toolCount: 4, lastTool: "bash", lastText: "Reading ToolExecutionView.ts now" },
      { key: "ui", label: "ui", agent: "worker", status: "completed", startedAt: 1_000, elapsedMs: 700, toolCount: 2, lastTool: "write", lastText: "Added the progress card." },
    ],
  };
}

function completedSnapshot(): SubagentRunProgress {
  return {
    runId: RUN_ID,
    state: "completed",
    startedAt: 1_000,
    updatedAt: 9_000,
    totalMs: 8_000,
    children: [
      { key: "scoring", label: "scoring", agent: "worker", status: "completed", startedAt: 1_000, elapsedMs: 9_000, toolCount: 6, lastTool: "read", lastText: "Lane finished." },
      { key: "ui", label: "ui", agent: "worker", status: "failed", startedAt: 1_000, elapsedMs: 700, toolCount: 2, lastTool: "write", lastText: "Typecheck failed.", isError: true },
    ],
  };
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function stubSequenceFetch(responses: Response[]): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => {
    const response = responses.shift();
    if (response === undefined) throw new Error("No fetch response queued");
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "Subagent run not found" }), { status: 404, headers: { "content-type": "application/json" } });
}
