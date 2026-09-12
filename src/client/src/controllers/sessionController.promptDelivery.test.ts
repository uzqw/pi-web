import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import type { MessagePage } from "../api";
import { SessionController } from "./sessionController";
import { EmitSocket, defaultApi, emptyPage, oldSession, runPendingAnimationFrames, status, workspace, type AppState } from "./sessionController.testSupport";

function controllerWith(state: AppState, apiOverrides: Partial<typeof defaultApi>): { controller: SessionController; socket: EmitSocket; state: () => AppState } {
  let liveState = state;
  const socket = new EmitSocket();
  const controller = new SessionController(
    () => liveState,
    (patch) => { liveState = { ...liveState, ...patch }; },
    () => undefined,
    undefined,
    { api: { ...defaultApi, ...apiOverrides }, socket },
  );
  return { controller, socket, state: () => liveState };
}

function promptMessagePage(text: string): MessagePage {
  return { messages: [{ role: "user", content: text }], start: 0, total: 1 };
}

function userTexts(state: AppState): string[] {
  return state.messages
    .filter((message) => message.role === "user")
    .map((message) => (message.parts[0]?.type === "text" ? message.parts[0].text : ""));
}

describe("SessionController prompt delivery", () => {
  it("drops an identical in-flight submission instead of delivering it twice", async () => {
    let resolvePrompt: (() => void) | undefined;
    let promptCalls = 0;
    const state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const { controller } = controllerWith(state, {
      prompt: () => new Promise<{ accepted: true }>((resolve) => {
        promptCalls += 1;
        resolvePrompt = () => { resolve({ accepted: true }); };
      }),
    });

    const first = controller.send("hello");
    const second = controller.send("hello");
    resolvePrompt?.();
    await Promise.all([first, second]);

    expect(promptCalls).toBe(1);
  });

  it("still delivers a different in-flight submission", async () => {
    const resolvers: (() => void)[] = [];
    const calls: string[] = [];
    const state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const { controller } = controllerWith(state, {
      prompt: (_session, text) => new Promise<{ accepted: true }>((resolve) => {
        calls.push(text);
        resolvers.push(() => { resolve({ accepted: true }); });
      }),
    });

    const first = controller.send("hello");
    const second = controller.send("world");
    for (const resolve of resolvers) resolve();
    await Promise.all([first, second]);

    expect(calls).toEqual(["hello", "world"]);
  });

  it("shows the prompt optimistically and replaces the row with the server echo", async () => {
    let resolvePrompt: (() => void) | undefined;
    const state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const { controller, socket, state: getState } = controllerWith(state, {
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      prompt: () => new Promise<{ accepted: true }>((resolve) => { resolvePrompt = () => { resolve({ accepted: true }); }; }),
    });
    await controller.selectSession(oldSession, { updateUrl: false });

    const send = controller.send("hello");
    expect(userTexts(getState())).toEqual(["hello"]);

    socket.emit({ type: "message.append", message: { role: "user", content: "hello" } });
    runPendingAnimationFrames();

    // The echo replaced the optimistic row instead of duplicating it.
    expect(userTexts(getState())).toEqual(["hello"]);

    resolvePrompt?.();
    await send;
  });

  it("keeps the optimistic row when a failed send actually landed", async () => {
    const state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const { controller, state: getState } = controllerWith(state, {
      prompt: () => Promise.reject(new TypeError("Failed to fetch")),
      messages: () => Promise.resolve(promptMessagePage("hello")),
    });

    await controller.send("hello");

    expect(userTexts(getState())).toEqual(["hello"]);
  });

  it("retracts the optimistic row when a failed send never reached the daemon", async () => {
    const state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const { controller, state: getState } = controllerWith(state, {
      prompt: () => Promise.reject(new TypeError("Failed to fetch")),
      messages: () => Promise.resolve(emptyPage),
    });

    await controller.send("hello");

    expect(userTexts(getState())).toEqual([]);
  });
});
