// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../api";
import { SessionList } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("session pinning", () => {
  it("renders the pin button stacked above the actions menu", async () => {
    const list = await renderList([session("a")]);

    const buttons = [...row(list, 0).querySelectorAll(".action-menu > button")];
    expect(buttons.map((button) => button.className.split(" ")[0])).toEqual(["action-pin-toggle", "action-menu-toggle"]);
  });

  it("floats a pinned session above the rest, newest pin first", async () => {
    const list = await renderList([session("a"), session("b"), session("c")]);

    await pinRow(list, 2); // c
    await pinRow(list, 2); // b, now that c took the top slot

    expect(labels(list)).toEqual(["b", "c", "a"]);
    expect(list.pinnedIds).toEqual(["b", "c"]);
  });

  it("unpins from the same button and drops the stored pin", async () => {
    const list = await renderList([session("b"), session("a")]);
    await pinRow(list, 1); // a
    expect(labels(list)).toEqual(["a", "b"]);

    await pinRow(list, 0); // a again

    expect(labels(list)).toEqual(["b", "a"]);
    expect(list.pinnedIds).toEqual([]);
    expect(row(list, 1).querySelector<HTMLButtonElement>(".action-pin-toggle")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("restores a stored pin order on first render", async () => {
    const list = await renderList([session("a"), session("b"), session("c")], ["b", "a"]);

    expect(labels(list)).toEqual(["b", "a", "c"]);
  });

  it("makes only pinned rows draggable", async () => {
    const list = await renderList([session("a"), session("b")]);
    await pinRow(list, 1);

    expect(row(list, 0).draggable).toBe(true);
    expect(row(list, 1).draggable).toBe(false);
  });

  it("offers no pin button on archived sessions", async () => {
    const list = await renderList([session("a", { archived: true })]);
    list.shadowRoot?.querySelector<HTMLButtonElement>(".section-toggle")?.click();
    await list.updateComplete;

    expect(row(list, 0).querySelector(".action-pin-toggle")).toBeNull();
    expect(row(list, 0).querySelector(".action-menu-toggle")?.classList.contains("solo")).toBe(true);
  });
});

async function renderList(sessions: SessionInfo[], pinnedIds: string[] = []): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  list.pinnedIds = pinnedIds;
  list.onChangePinnedIds = (ids) => { list.pinnedIds = ids; };
  document.body.append(list);
  await list.updateComplete;
  return list;
}

async function pinRow(list: SessionList, index: number): Promise<void> {
  row(list, index).querySelector<HTMLButtonElement>(".action-pin-toggle")?.click();
  await list.updateComplete;
}

function labels(list: SessionList): string[] {
  return [...list.shadowRoot?.querySelectorAll(".action-row .action-name") ?? []].map((name) => name.textContent.trim());
}

function row(list: SessionList, index: number): HTMLElement {
  const found = [...list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? []][index];
  if (found === undefined) throw new Error(`No session row at index ${String(index)}`);
  return found;
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/srv/dev/pi-web",
    created: "2026-07-28T00:00:00.000Z",
    modified: "2026-07-28T00:00:00.000Z",
    messageCount: 3,
    firstMessage: id,
    ...overrides,
  };
}
