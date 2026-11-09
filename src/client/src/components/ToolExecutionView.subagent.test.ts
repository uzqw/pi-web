// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionPart } from "./shared";
import { ToolExecutionView } from "./ToolExecutionView";
import type { SubagentProgressView } from "./SubagentProgressView";

const RUN_ID = "2f1d3c4b-5a69-4b7c-8d90-1a2b3c4d5e6f";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("tool execution subagent progress", () => {
  it("mounts live progress for an async subagent run", async () => {
    stubMissingRun();
    const view = await mount(subagentExecution({ asyncId: RUN_ID, runId: RUN_ID }));

    expect(progressRunId(view)).toBe(RUN_ID);
  });

  it("leaves a foreground subagent call and other tools unchanged", async () => {
    const fetchMock = stubMissingRun();

    expect(progressRunId(await mount(subagentExecution({ runId: RUN_ID })))).toBeUndefined();
    expect(progressRunId(await mount({ type: "toolExecution", toolName: "bash", summary: "npm test", status: "success", details: { asyncId: RUN_ID } }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function mount(execution: ToolExecutionPart): Promise<ToolExecutionView> {
  const view = new ToolExecutionView();
  view.execution = execution;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function subagentExecution(details: Record<string, unknown>): ToolExecutionPart {
  return { type: "toolExecution", toolName: "subagent", summary: "worker: scoring", status: "running", details };
}

function progressRunId(view: ToolExecutionView): string | undefined {
  const element = view.renderRoot.querySelector<SubagentProgressView>("subagent-progress");
  return element?.runId;
}

function stubMissingRun(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "Subagent run not found" }), { status: 404, headers: { "content-type": "application/json" } })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
