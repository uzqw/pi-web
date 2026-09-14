// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import type { ModelPreset } from "../modelPresets";
import { PromptEditor } from "./PromptEditor";

function status(model?: { provider?: string; id?: string }, thinkingLevel?: string): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

const PRESET: ModelPreset = { provider: "devin", id: "swe-2-high", thinkingLevel: "high" };

async function mountEditor(props: Partial<PromptEditor>): Promise<PromptEditor> {
  const editor = new PromptEditor();
  Object.assign(editor, props);
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function presetButtons(editor: PromptEditor): HTMLButtonElement[] {
  return Array.from(editor.shadowRoot?.querySelectorAll<HTMLButtonElement>(".model-preset") ?? []);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("PromptEditor model preset chips", () => {
  it("renders nothing when no pick callback is wired", async () => {
    const editor = await mountEditor({ status: status({ provider: "devin", id: "swe-2-high" }), modelPresets: [PRESET] });
    expect(editor.shadowRoot?.querySelector(".model-presets")).toBeNull();
  });

  it("renders numbered chips and hides '+' when the current model is already a preset", async () => {
    const onAdd = vi.fn();
    const editor = await mountEditor({
      status: status({ provider: "devin", id: "swe-2-high" }, "low"),
      modelPresets: [PRESET, { provider: "anthropic", id: "claude-sonnet-4-5" }],
      onPickModelPreset: vi.fn(),
      onAddModelPreset: onAdd,
    });
    const buttons = presetButtons(editor);
    expect(buttons.map((button) => button.textContent.trim())).toEqual(["1", "2"]);
    expect(buttons[0]?.classList.contains("current")).toBe(true);
    expect(buttons[1]?.classList.contains("current")).toBe(false);
  });

  it("shows '+' while the current model is not saved and captures it on click", async () => {
    const onAdd = vi.fn();
    const editor = await mountEditor({
      status: status({ provider: "openai", id: "gpt-5" }, "medium"),
      modelPresets: [PRESET],
      onPickModelPreset: vi.fn(),
      onAddModelPreset: onAdd,
    });
    const add = presetButtons(editor).find((button) => button.classList.contains("model-preset-add"));
    expect(add).toBeDefined();
    add?.click();
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("applies a preset on click and removes it on right-click", async () => {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    const editor = await mountEditor({
      status: status({ provider: "openai", id: "gpt-5" }),
      modelPresets: [PRESET],
      onPickModelPreset: onPick,
      onRemoveModelPreset: onRemove,
    });
    const chip = presetButtons(editor)[0];
    if (chip === undefined) throw new Error("preset chip was not rendered");
    chip.click();
    expect(onPick).toHaveBeenCalledWith(PRESET);
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onRemove).toHaveBeenCalledWith(PRESET);
  });
});
