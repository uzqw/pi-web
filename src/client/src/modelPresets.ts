import type { SessionStatus } from "./api";

/**
 * Quick-switch model+thinking presets shown as numbered chips next to the
 * prompt editor's model button. Clicking a chip applies both the model and the
 * thinking level to the selected session. Presets are browser-local
 * (localStorage) and shared across sessions/machines — the same slots apply
 * everywhere, matching how drafts/pins already persist per browser.
 *
 * ponytail: presets are global, not per-session or per-workspace. If users ask
 * for scoped presets, key the storage by workspace/machine then.
 */

export interface ModelPreset {
  provider: string;
  id: string;
  /** Thinking level applied with the model; undefined leaves the session's level alone. */
  thinkingLevel?: string;
}

export const MAX_MODEL_PRESETS = 9;

const STORAGE_KEY = "pi-web:model-presets";

interface PresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PresetStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePreset(candidate: unknown): ModelPreset | undefined {
  if (!isRecord(candidate)) return undefined;
  const provider = candidate["provider"];
  const id = candidate["id"];
  if (typeof provider !== "string" || provider === "") return undefined;
  if (typeof id !== "string" || id === "") return undefined;
  const thinkingLevel = candidate["thinkingLevel"];
  return {
    provider,
    id,
    ...(typeof thinkingLevel === "string" && thinkingLevel !== "" ? { thinkingLevel } : {}),
  };
}

export function loadModelPresets(storage = browserStorage()): ModelPreset[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const presets: ModelPreset[] = [];
    for (const candidate of parsed) {
      const preset = normalizePreset(candidate);
      if (preset === undefined) continue;
      if (presets.some((existing) => existing.provider === preset.provider && existing.id === preset.id)) continue;
      presets.push(preset);
      if (presets.length >= MAX_MODEL_PRESETS) break;
    }
    return presets;
  } catch {
    return [];
  }
}

export function saveModelPresets(presets: readonly ModelPreset[], storage = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_MODEL_PRESETS)));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

/** The preset the session's current status matches, if any (model only — thinking is applied on top). */
export function presetMatchesStatus(preset: ModelPreset, status: SessionStatus | undefined): boolean {
  return status?.model?.provider === preset.provider && status.model.id === preset.id;
}

/** Build the preset a "+" button would capture from the current status. */
export function presetFromStatus(status: SessionStatus | undefined): ModelPreset | undefined {
  const provider = status?.model?.provider;
  const id = status?.model?.id;
  if (provider === undefined || provider === "" || id === undefined || id === "") return undefined;
  const thinkingLevel = status?.thinkingLevel;
  return { provider, id, ...(thinkingLevel !== undefined && thinkingLevel !== "" ? { thinkingLevel } : {}) };
}
