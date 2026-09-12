import { describe, expect, it } from "vitest";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  NAVIGATION_COLLAPSED_SECTIONS_STORAGE_KEY,
  NavigationSectionsController,
  collapsedSectionsExcept,
  defaultNavigationSection,
  expandNavigationSection,
  expandedNavigationSection,
  isNavigationSectionCollapsed,
  nextNavigationSection,
  readStoredCollapsedNavigationSections,
  toggleNavigationSection,
} from "./navigationState";

describe("navigationState", () => {
  it("follows the selection until the user opens a tab", () => {
    expect(defaultNavigationSection({ selectedProject: undefined, selectedWorkspace: undefined })).toBe("projects");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: undefined })).toBe("workspaces");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: {} })).toBe("sessions");
    expect(collapsedSectionsExcept("sessions")).toEqual(["machines", "projects", "workspaces"]);
  });

  it("expands the default section until the user explicitly opens a mobile section", () => {
    const state = { selectedProject: {}, selectedWorkspace: undefined };

    expect(expandedNavigationSection(undefined, state)).toBe("workspaces");
    expect(expandedNavigationSection("sessions", state)).toBe("sessions");
    expect(expandedNavigationSection("none", state)).toBeUndefined();
  });

  it("uses the mobile accordion state on mobile layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: true, expanded: "sessions", state })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: true, expanded: "sessions", state })).toBe(false);
  });

  it("keeps desktop sections collapsed from the stored tab list", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state })).toBe(false);
    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(false);
  });

  it("toggles the effective mobile section, including the implicit default section", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection(undefined, "projects", { isMobileLayout: true, state })).toBe("none");
    expect(toggleNavigationSection("none", "projects", { isMobileLayout: true, state })).toBe("projects");
    expect(toggleNavigationSection("projects", "workspaces", { isMobileLayout: true, state })).toBe("workspaces");
  });

  it("ignores the mobile expanded state on desktop layouts", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection("projects", "projects", { isMobileLayout: false, state })).toBe("projects");
    expect(expandNavigationSection("none", "projects", false)).toBe("none");
  });

  it("advances to the next mobile section after a selection", () => {
    expect(nextNavigationSection("projects")).toBe("sessions");
    expect(nextNavigationSection("workspaces")).toBe("sessions");
    expect(nextNavigationSection("sessions")).toBeUndefined();
    expect(expandNavigationSection("none", "projects", true)).toBe("projects");
  });
});

describe("navigation section tab persistence", () => {
  const selection = { selectedProject: {}, selectedWorkspace: {} };

  it("starts with the selection-decided tab open before the user opens one", () => {
    const controller = controllerWithState(new FakeStorage());

    expect(controller.activeSection()).toBe("sessions");
    expect(controller.isCollapsed("sessions")).toBe(false);
    expect(controller.isCollapsed("machines")).toBe(true);
    expect(controller.isCollapsed("projects")).toBe(true);
    expect(controller.isCollapsed("workspaces")).toBe(true);
  });

  it("follows the selection for the open tab when nothing usable is stored", () => {
    expect(readStoredCollapsedNavigationSections(new FakeStorage())).toBeUndefined();
    expect(controllerWithState(new FakeStorage(), fakeHost(), () => ({ selectedProject: {}, selectedWorkspace: undefined })).activeSection()).toBe("workspaces");

    for (const stored of ["not json", JSON.stringify({ version: 9, sections: ["projects"] }), JSON.stringify(["projects"])]) {
      const storage = new FakeStorage({ [NAVIGATION_COLLAPSED_SECTIONS_STORAGE_KEY]: stored });
      expect(readStoredCollapsedNavigationSections(storage)).toBeUndefined();
    }
  });

  it("ignores section names it does not know", () => {
    const storage = new FakeStorage({ [NAVIGATION_COLLAPSED_SECTIONS_STORAGE_KEY]: JSON.stringify({ version: 1, sections: ["projects", "not-a-section", 7] }) });

    expect(readStoredCollapsedNavigationSections(storage)).toEqual(["projects"]);
    // The stored list names the collapsed sections, so projects collapses and
    // the first section after it opens.
    expect(controllerWithState(storage).activeSection()).toBe("machines");
  });

  it("keeps the chosen tab across loads: the stored collapse list wins over the selection", () => {
    const storage = new FakeStorage();
    const host = fakeHost();
    const controller = controllerWithState(storage, host);

    expect(host.controllers).toEqual([controller]);

    controller.expand("projects");
    expect(host.updateCount).toBe(1);
    expect(readStoredCollapsedNavigationSections(storage)).toEqual(collapsedSectionsExcept("projects"));
    expect(controllerWithState(storage).activeSection()).toBe("projects");

    // Reload under a selection that would default to another tab: the stored
    // choice still wins.
    const reloaded = new NavigationSectionsController(fakeHost(), () => ({ selectedProject: {}, selectedWorkspace: undefined }), () => false, { storage });
    expect(reloaded.activeSection()).toBe("projects");
  });

  it("has no closed state on desktop: activating the open tab leaves it open", () => {
    const storage = new FakeStorage();
    const host = fakeHost();
    const controller = controllerWithState(storage, host);

    controller.toggle("sessions");
    expect(controller.activeSection()).toBe("sessions");

    const updates = host.updateCount;
    controller.toggle("sessions");
    expect(host.updateCount).toBe(updates);
    expect(controller.activeSection()).toBe("sessions");
  });

  it("keeps the mobile accordion independent of the stored desktop sections", () => {
    const controller = new NavigationSectionsController(fakeHost(), () => selection, () => true, { storage: new FakeStorage() });

    expect(controller.isCollapsed("sessions")).toBe(false);
    expect(controller.isCollapsed("workspaces")).toBe(true);

    controller.toggle("sessions");
    expect(controller.isCollapsed("sessions")).toBe(true);
    controller.toggle("sessions");
    expect(controller.isCollapsed("sessions")).toBe(false);
  });

  it("advances the mobile accordion through the sections a selection flows into", () => {
    const controller = new NavigationSectionsController(fakeHost(), () => selection, () => true, { storage: new FakeStorage() });

    // A project pick goes straight to sessions: the workspace comes from memory.
    controller.advanceAfterSelection("projects");
    expect(controller.isCollapsed("sessions")).toBe(false);
    controller.advanceAfterSelection("workspaces");
    expect(controller.isCollapsed("sessions")).toBe(false);
    // Sessions is the last section: nothing left to advance into.
    controller.advanceAfterSelection("sessions");
    expect(controller.isCollapsed("sessions")).toBe(false);
  });

  it("opens a mobile section and reports the open navigation view", () => {
    const controller = new NavigationSectionsController(fakeHost(), () => selection, () => true, { storage: new FakeStorage() });
    let opened = false;

    controller.open("projects", () => { opened = true; });

    expect(controller.isCollapsed("projects")).toBe(false);
    expect(opened).toBe(true);
  });

  function controllerWithState(storage: FakeStorage, host: FakeHost = fakeHost(), getState: () => { selectedProject: object | undefined; selectedWorkspace: object | undefined } = () => selection): NavigationSectionsController {
    return new NavigationSectionsController(host, getState, () => false, { storage });
  }
});

function fakeHost(): FakeHost {
  return new FakeHost();
}

class FakeHost implements ReactiveControllerHost {
  readonly updateComplete: Promise<boolean> = Promise.resolve(true);
  readonly controllers: ReactiveController[] = [];
  updateCount = 0;

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    const index = this.controllers.indexOf(controller);
    if (index >= 0) this.controllers.splice(index, 1);
  }

  requestUpdate(): void {
    this.updateCount += 1;
  }
}

class FakeStorage {
  private readonly values = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
