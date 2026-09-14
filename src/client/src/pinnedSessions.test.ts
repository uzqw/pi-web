import { describe, expect, it } from "vitest";
import { loadPinnedSessionIds, movePinnedId, savePinnedSessionIds, togglePinnedId, type PinStorage } from "./pinnedSessions";

function fakeStorage(initial?: string): { storage: PinStorage; value: () => string | null } {
  let value = initial ?? null;
  return {
    storage: {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next; },
    },
    value: () => value,
  };
}

describe("pinned session storage", () => {
  it("reads a stored order and drops malformed or duplicate entries", () => {
    expect(loadPinnedSessionIds(fakeStorage('["b","a","b","",3]').storage)).toEqual(["b", "a"]);
  });

  it("returns an empty order for missing, non-array, or unparsable values", () => {
    expect(loadPinnedSessionIds(fakeStorage().storage)).toEqual([]);
    expect(loadPinnedSessionIds(fakeStorage("{}").storage)).toEqual([]);
    expect(loadPinnedSessionIds(fakeStorage("not json").storage)).toEqual([]);
  });

  it("persists the order as JSON", () => {
    const { storage, value } = fakeStorage();
    savePinnedSessionIds(["a", "b"], storage);
    expect(value()).toBe('["a","b"]');
  });
});

describe("togglePinnedId", () => {
  it("prepends a new pin so the newest pin sits on top", () => {
    expect(togglePinnedId(["a"], "b")).toEqual(["b", "a"]);
    expect(togglePinnedId([], "a")).toEqual(["a"]);
  });

  it("removes an existing pin", () => {
    expect(togglePinnedId(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("movePinnedId", () => {
  it("moves a pin into the target's slot, before the target", () => {
    expect(movePinnedId(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(movePinnedId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("leaves the order unchanged for a no-op or unknown id", () => {
    expect(movePinnedId(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(movePinnedId(["a", "b"], "a", "missing")).toEqual(["a", "b"]);
  });
});
