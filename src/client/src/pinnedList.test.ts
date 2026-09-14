import { describe, expect, it } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { movePinnedId, parsePinnedIds, PinnedListController, togglePinnedId } from "./pinnedList";

class FakeHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  updates = 0;
  addController(): void { /* no-op */ }
  removeController(): void { /* no-op */ }
  requestUpdate(): void { this.updates += 1; }
}

describe("PinnedListController.partition", () => {
  it("lifts pinned items to the top in pin order and keeps the rest in place", () => {
    const pins = new PinnedListController(new FakeHost(), () => undefined, ["c", "a"]);

    const { pinned, rest } = pins.partition(["a", "b", "c"].map((id) => ({ id })), (item) => item.id);

    expect(pinned.map((item) => item.id)).toEqual(["c", "a"]);
    expect(rest.map((item) => item.id)).toEqual(["b"]);
  });

  it("skips pinned ids with no matching item", () => {
    const pins = new PinnedListController(new FakeHost(), () => undefined, ["missing", "b"]);

    const { pinned, rest } = pins.partition([{ id: "a" }, { id: "b" }], (item) => item.id);

    expect(pinned.map((item) => item.id)).toEqual(["b"]);
    expect(rest.map((item) => item.id)).toEqual(["a"]);
  });

  it("reports a toggle through onChange and adopts a server order via setIds", () => {
    const changes: string[][] = [];
    const pins = new PinnedListController(new FakeHost(), (ids) => { changes.push(ids); }, []);

    pins.toggle("a");
    pins.setIds(["b", "a"]);

    expect(changes).toEqual([["a"]]);
    expect(pins.ids).toEqual(["b", "a"]);
  });
});

describe("parsePinnedIds", () => {
  it("reads a stored order and drops malformed or duplicate entries", () => {
    expect(parsePinnedIds(["b", "a", "b", "", 3])).toEqual(["b", "a"]);
  });

  it("returns an empty order for non-array values", () => {
    expect(parsePinnedIds(undefined)).toEqual([]);
    expect(parsePinnedIds({})).toEqual([]);
    expect(parsePinnedIds("not json")).toEqual([]);
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
