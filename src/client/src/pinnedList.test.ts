import { describe, expect, it } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { loadPinnedIds, movePinnedId, PinnedListController, savePinnedIds, togglePinnedId, type PinStorage } from "./pinnedList";

class FakeHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  updates = 0;
  addController(): void { /* no-op */ }
  removeController(): void { /* no-op */ }
  requestUpdate(): void { this.updates += 1; }
}

describe("PinnedListController.partition", () => {
  it("lifts pinned items to the top in pin order and keeps the rest in place", () => {
    const { storage } = fakeStorage({ k: '["c","a"]' });
    const pins = new PinnedListController(new FakeHost(), "k", storage);

    const { pinned, rest } = pins.partition(["a", "b", "c"].map((id) => ({ id })), (item) => item.id);

    expect(pinned.map((item) => item.id)).toEqual(["c", "a"]);
    expect(rest.map((item) => item.id)).toEqual(["b"]);
  });

  it("skips pinned ids with no matching item", () => {
    const { storage } = fakeStorage({ k: '["missing","b"]' });
    const pins = new PinnedListController(new FakeHost(), "k", storage);

    const { pinned, rest } = pins.partition([{ id: "a" }, { id: "b" }], (item) => item.id);

    expect(pinned.map((item) => item.id)).toEqual(["b"]);
    expect(rest.map((item) => item.id)).toEqual(["a"]);
  });
});

function fakeStorage(initial?: Record<string, string>): { storage: PinStorage; value: (key: string) => string | null } {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, next: string) => { values.set(key, next); },
    },
    value: (key: string) => values.get(key) ?? null,
  };
}

describe("pinned id storage", () => {
  it("reads a stored order and drops malformed or duplicate entries", () => {
    expect(loadPinnedIds("k", fakeStorage({ k: '["b","a","b","",3]' }).storage)).toEqual(["b", "a"]);
  });

  it("returns an empty order for missing, non-array, or unparsable values", () => {
    expect(loadPinnedIds("k", fakeStorage().storage)).toEqual([]);
    expect(loadPinnedIds("k", fakeStorage({ k: "{}" }).storage)).toEqual([]);
    expect(loadPinnedIds("k", fakeStorage({ k: "not json" }).storage)).toEqual([]);
  });

  it("persists each list under its own key", () => {
    const { storage, value } = fakeStorage();
    savePinnedIds("sessions", ["a"], storage);
    savePinnedIds("projects", ["p"], storage);
    expect(value("sessions")).toBe('["a"]');
    expect(value("projects")).toBe('["p"]');
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
