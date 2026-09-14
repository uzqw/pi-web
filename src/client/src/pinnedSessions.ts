const storageKey = "pi-web:pinned-sessions";

/** Narrow storage seam so pin persistence is testable without a DOM. */
export interface PinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PinStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Pin order is significant: index 0 is the top row, so a newly pinned session
 * sits above every earlier pin ("later pins win").
 */
export function loadPinnedSessionIds(storage = browserStorage()): string[] {
  try {
    const raw = storage?.getItem(storageKey);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const candidate of parsed) {
      if (typeof candidate !== "string" || candidate === "" || seen.has(candidate)) continue;
      seen.add(candidate);
      ids.push(candidate);
    }
    return ids;
  } catch {
    return [];
  }
}

export function savePinnedSessionIds(ids: readonly string[], storage = browserStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

/** Pin a session at the top, or remove it when it is already pinned. */
export function togglePinnedId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [id, ...ids];
}

/** Move `fromId` into `toId`'s slot, preserving the rest of the pin order. */
export function movePinnedId(ids: readonly string[], fromId: string, toId: string): string[] {
  if (fromId === toId || !ids.includes(fromId) || !ids.includes(toId)) return [...ids];
  const next = ids.filter((id) => id !== fromId);
  next.splice(next.indexOf(toId), 0, fromId);
  return next;
}
