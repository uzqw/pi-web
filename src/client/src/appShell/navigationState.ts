import type { ReactiveController, ReactiveControllerHost } from "lit";

export const NAVIGATION_SECTION_ORDER = ["machines", "projects", "workspaces", "sessions"] as const;
export type NavigationSection = (typeof NAVIGATION_SECTION_ORDER)[number];
export type ExpandedNavigationSection = NavigationSection | "none" | undefined;

export type NavigationSectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface NavigationSectionsControllerOptions {
  storage?: NavigationSectionStorage;
}

/**
 * Desktop shows one section at a time: the open tab keeps its list, and every
 * other section collapses down to its heading so the open list gets the room.
 */
export function collapsedSectionsExcept(active: NavigationSection): NavigationSection[] {
  return NAVIGATION_SECTION_ORDER.filter((section) => section !== active);
}

export const NAVIGATION_COLLAPSED_SECTIONS_STORAGE_KEY = "pi-web:navigation-collapsed-sections:v1";

interface StoredCollapsedNavigationSections {
  version: 1;
  sections: unknown[];
}

export interface NavigationSelectionState {
  selectedProject: object | undefined;
  selectedWorkspace: object | undefined;
}

export function defaultNavigationSection(state: NavigationSelectionState): NavigationSection {
  if (state.selectedProject === undefined) return "projects";
  if (state.selectedWorkspace === undefined) return "workspaces";
  return "sessions";
}

export function expandedNavigationSection(expanded: ExpandedNavigationSection, state: NavigationSelectionState): NavigationSection | undefined {
  if (expanded === "none") return undefined;
  return expanded ?? defaultNavigationSection(state);
}

export function isNavigationSectionCollapsed(section: NavigationSection, options: { isMobileLayout: boolean; expanded: ExpandedNavigationSection; state: NavigationSelectionState; collapsedSections?: readonly NavigationSection[] | undefined }): boolean {
  if (options.isMobileLayout) return expandedNavigationSection(options.expanded, options.state) !== section;
  return options.collapsedSections?.includes(section) ?? false;
}

export function toggleNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, options: { isMobileLayout: boolean; state: NavigationSelectionState }): ExpandedNavigationSection {
  if (!options.isMobileLayout) return expanded;
  return expandedNavigationSection(expanded, options.state) === section ? "none" : section;
}

export function expandNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, isMobileLayout: boolean): ExpandedNavigationSection {
  return isMobileLayout ? section : expanded;
}

export function nextNavigationSection(section: NavigationSection): NavigationSection | undefined {
  // A project selection flows straight into sessions: the workspace is picked
  // from memory (or its first listing), so there is no intermediate stop.
  if (section === "projects") return "sessions";
  return NAVIGATION_SECTION_ORDER[NAVIGATION_SECTION_ORDER.indexOf(section) + 1];
}

export class NavigationSectionsController implements ReactiveController {
  private expanded: ExpandedNavigationSection;
  /** `undefined` until the user opens a tab: the selection decides which one is open. */
  private collapsedSections: readonly NavigationSection[] | undefined;
  private readonly storage: NavigationSectionStorage | undefined;

  hostConnected(): void {
    return;
  }

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getState: () => NavigationSelectionState,
    private readonly isMobileLayout: () => boolean,
    options: NavigationSectionsControllerOptions = {},
  ) {
    host.addController(this);
    this.storage = options.storage ?? browserNavigationSectionStorage();
    this.collapsedSections = readStoredCollapsedNavigationSections(this.storage);
  }

  expandedSection(): NavigationSection | undefined {
    return expandedNavigationSection(this.expanded, this.getState());
  }

  /**
   * The desktop tab that is open. Exactly one section is open on desktop, so
   * this is the section a stored collapsed list leaves expanded; before the
   * user has opened a tab it follows the current project/workspace selection.
   */
  activeSection(): NavigationSection {
    const collapsed = this.effectiveCollapsedSections();
    return NAVIGATION_SECTION_ORDER.find((section) => !collapsed.includes(section)) ?? defaultNavigationSection(this.getState());
  }

  isCollapsed(section: NavigationSection): boolean {
    if (!this.isMobileLayout()) return this.effectiveCollapsedSections().includes(section);
    return isNavigationSectionCollapsed(section, {
      isMobileLayout: true,
      expanded: this.expanded,
      state: this.getState(),
    });
  }

  toggle(section: NavigationSection): void {
    if (this.isMobileLayout()) {
      this.setExpanded(toggleNavigationSection(this.expanded, section, { isMobileLayout: true, state: this.getState() }));
      return;
    }
    // Desktop tabs have no closed state to toggle back to: opening the open tab
    // again leaves it open.
    this.setCollapsedSections(collapsedSectionsExcept(section));
  }

  expand(section: NavigationSection): void {
    if (this.isMobileLayout()) {
      this.setExpanded(expandNavigationSection(this.expanded, section, true));
      return;
    }
    this.setCollapsedSections(collapsedSectionsExcept(section));
  }

  advanceAfterSelection(section: NavigationSection): void {
    if (!this.isMobileLayout()) return;
    const next = nextNavigationSection(section);
    if (next !== undefined) this.expand(next);
  }

  open(section: NavigationSection, openNavigationView: () => void): void {
    if (!this.isMobileLayout()) return;
    this.expand(section);
    openNavigationView();
  }

  private setExpanded(expanded: ExpandedNavigationSection): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.host.requestUpdate();
  }

  private setCollapsedSections(collapsedSections: readonly NavigationSection[]): void {
    if (this.collapsedSections !== undefined && navigationSectionListsEqual(this.collapsedSections, collapsedSections)) return;
    this.collapsedSections = collapsedSections;
    writeStoredCollapsedNavigationSections(collapsedSections, this.storage);
    this.host.requestUpdate();
  }

  private effectiveCollapsedSections(): readonly NavigationSection[] {
    return this.collapsedSections ?? collapsedSectionsExcept(defaultNavigationSection(this.getState()));
  }
}

/**
 * The sections collapsed on desktop, or `undefined` when the user has never
 * opened a tab — the controller then derives them from the current selection.
 */
export function readStoredCollapsedNavigationSections(storage: NavigationSectionStorage | undefined = browserNavigationSectionStorage()): readonly NavigationSection[] | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(NAVIGATION_COLLAPSED_SECTIONS_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredCollapsedNavigationSections(parsed)) return undefined;
    return orderedNavigationSections(parsed.sections.filter(isNavigationSection));
  } catch {
    return undefined;
  }
}

export function writeStoredCollapsedNavigationSections(collapsedSections: readonly NavigationSection[], storage: NavigationSectionStorage | undefined = browserNavigationSectionStorage()): void {
  if (storage === undefined) return;
  try {
    const stored: StoredCollapsedNavigationSections = { version: 1, sections: [...collapsedSections] };
    storage.setItem(NAVIGATION_COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Ignore localStorage quota/privacy errors; the collapse still applies in memory for this tab.
  }
}

function orderedNavigationSections(sections: Iterable<NavigationSection>): NavigationSection[] {
  const sectionSet = new Set(sections);
  return NAVIGATION_SECTION_ORDER.filter((section) => sectionSet.has(section));
}

function navigationSectionListsEqual(first: readonly NavigationSection[], second: readonly NavigationSection[]): boolean {
  return first.length === second.length && first.every((section, index) => section === second[index]);
}

function isStoredCollapsedNavigationSections(value: unknown): value is StoredCollapsedNavigationSections {
  return isRecord(value) && value["version"] === 1 && Array.isArray(value["sections"]);
}

function isNavigationSection(value: unknown): value is NavigationSection {
  if (typeof value !== "string") return false;
  return NAVIGATION_SECTION_ORDER.some((section) => section === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function browserNavigationSectionStorage(): NavigationSectionStorage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}
