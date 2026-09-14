// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Project, Workspace } from "../api";
import { loadPinnedIds } from "../pinnedList";
import { ProjectList } from "./ProjectList";
import { WorkspaceList } from "./WorkspaceList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("project pinning", () => {
  it("floats a pinned project above the rest, newest pin first", async () => {
    const list = await renderProjects(["a", "b", "c"]);

    await pinRow(list, 2); // c
    await pinRow(list, 2); // b, now that c took the top slot

    expect(labels(list)).toEqual(["b", "c", "a"]);
    expect(loadPinnedIds("pi-web:pinned-projects")).toEqual(["b", "c"]);
  });

  it("makes only pinned project rows draggable", async () => {
    const list = await renderProjects(["a", "b"]);
    await pinRow(list, 1);

    expect(row(list, 0).draggable).toBe(true);
    expect(row(list, 1).draggable).toBe(false);
  });
});

describe("workspace pinning", () => {
  it("floats a pinned workspace above the rest and unpins back to its place", async () => {
    const list = await renderWorkspaces(["a", "b", "c"]);

    await pinRow(list, 2); // c
    expect(labels(list)).toEqual(["c", "a", "b"]);

    await pinRow(list, 0); // c again
    expect(labels(list)).toEqual(["a", "b", "c"]);
    expect(loadPinnedIds("pi-web:pinned-workspaces")).toEqual([]);
  });
});

async function renderProjects(ids: string[]): Promise<ProjectList> {
  const list = new ProjectList();
  list.projects = ids.map(project);
  document.body.append(list);
  await list.updateComplete;
  return list;
}

async function renderWorkspaces(ids: string[]): Promise<WorkspaceList> {
  const list = new WorkspaceList();
  list.workspaces = ids.map(workspace);
  document.body.append(list);
  await list.updateComplete;
  return list;
}

async function pinRow(list: ProjectList | WorkspaceList, index: number): Promise<void> {
  row(list, index).querySelector<HTMLButtonElement>(".action-pin-toggle")?.click();
  await list.updateComplete;
}

function labels(list: ProjectList | WorkspaceList): string[] {
  return [...list.shadowRoot?.querySelectorAll(".action-row .workspace-primary-label") ?? []].map((label) => label.textContent.trim());
}

function row(list: ProjectList | WorkspaceList, index: number): HTMLElement {
  const found = [...list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? []][index];
  if (found === undefined) throw new Error(`No row at index ${String(index)}`);
  return found;
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}

function workspace(id: string): Workspace {
  return { id, projectId: "project-1", path: `/repo/${id}`, label: id, isMain: false, effectiveConfig: {} };
}
