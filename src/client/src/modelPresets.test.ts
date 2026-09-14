import { describe, expect, it } from "vitest";
import { loadModelPresets, MAX_MODEL_PRESETS, presetFromStatus, presetMatchesStatus, saveModelPresets, type ModelPreset } from "./modelPresets";
import type { SessionStatus } from "./api";

function memoryStorage(initial?: string) {
  let value = initial;
  return {
    getItem: () => value ?? null,
    setItem: (_key: string, next: string) => { value = next; },
    get stored() { return value; },
  };
}

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

describe("modelPresets", () => {
  it("round-trips presets through storage", () => {
    const storage = memoryStorage();
    const presets: ModelPreset[] = [
      { provider: "devin", id: "swe-2-high", thinkingLevel: "high" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    ];
    saveModelPresets(presets, storage);
    expect(loadModelPresets(storage)).toEqual(presets);
  });

  it("drops malformed entries and duplicate models", () => {
    const storage = memoryStorage(JSON.stringify([
      { provider: "a", id: "m1" },
      { provider: "a", id: "m1", thinkingLevel: "low" },
      { provider: "", id: "bad" },
      { id: "no-provider" },
      "junk",
      { provider: "b", id: "m2", thinkingLevel: 3 },
    ]));
    expect(loadModelPresets(storage)).toEqual([
      { provider: "a", id: "m1" },
      { provider: "b", id: "m2" },
    ]);
  });

  it("caps stored presets at the maximum", () => {
    const storage = memoryStorage();
    const presets = Array.from({ length: MAX_MODEL_PRESETS + 3 }, (_, index) => ({ provider: "p", id: `m${String(index)}` }));
    saveModelPresets(presets, storage);
    expect(loadModelPresets(storage)).toHaveLength(MAX_MODEL_PRESETS);
  });

  it("returns an empty list for missing or corrupt storage", () => {
    expect(loadModelPresets(memoryStorage())).toEqual([]);
    expect(loadModelPresets(memoryStorage("not json"))).toEqual([]);
    expect(loadModelPresets(undefined)).toEqual([]);
  });

  it("captures a preset from the current status", () => {
    expect(presetFromStatus(status({ provider: "devin", id: "swe-2-high" }, "high"))).toEqual({ provider: "devin", id: "swe-2-high", thinkingLevel: "high" });
    expect(presetFromStatus(status({ provider: "devin", id: "swe-2-high" }))).toEqual({ provider: "devin", id: "swe-2-high" });
    expect(presetFromStatus(status())).toBeUndefined();
    expect(presetFromStatus(undefined)).toBeUndefined();
  });

  it("matches a preset to the current model only", () => {
    const preset: ModelPreset = { provider: "devin", id: "swe-2-high", thinkingLevel: "high" };
    expect(presetMatchesStatus(preset, status({ provider: "devin", id: "swe-2-high" }, "low"))).toBe(true);
    expect(presetMatchesStatus(preset, status({ provider: "devin", id: "other" }, "high"))).toBe(false);
    expect(presetMatchesStatus(preset, undefined)).toBe(false);
  });
});
