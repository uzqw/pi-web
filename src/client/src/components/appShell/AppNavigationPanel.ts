import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { Machine, MachineHealth, Project, SessionActivity, SessionInfo, SessionStatus, Workspace } from "../../api";
import type { MachineStatusSnapshot, StatusFlags } from "../../../../shared/machineStatus";
import { rollUpStatusFlags } from "../../../../shared/machineStatus";
import type { WorkspaceLabelItem } from "../../plugins/types";
import { selectedMachineId } from "../../controllers/types";
import type { NavigationSection } from "../../appShell/navigationState";
import { NAVIGATION_SECTION_ORDER } from "../../appShell/navigationState";
import type { KeyboardNavigableSection } from "../navigationFocus";
import { hasStatusUnread, renderActivityIndicator, statusActivityKind, type ActivityIndicatorKind } from "../activityBadge";
import { sessionRowActivityKind, sessionRowUnread } from "../SessionList";
import "../MachineList";
import "../MachineSwitcher";
import "../ProjectList";
import "../WorkspaceList";
import "../SessionList";

export type NavigationFocusTarget = NavigationSection | "chat";

/**
 * One clickable project in the desktop activity row. The row lists lit
 * projects only, resolved against the currently selected machine.
 */
export interface NavigationActivityItem {
  readonly machineId: string;
  readonly projectId: string;
}

export interface NavigationActivityOptions {
  machineId: string;
  snapshot: MachineStatusSnapshot | undefined;
  projects: readonly Project[];
}

/** The dot a desktop tab shows for one section. */
export interface NavigationSectionActivity {
  kind: ActivityIndicatorKind | undefined;
  unread: boolean;
}

export interface NavigationSectionActivityOptions {
  machines: readonly Machine[];
  machineStatusSnapshots: Record<string, MachineStatusSnapshot>;
  snapshot: MachineStatusSnapshot | undefined;
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  sessions: readonly SessionInfo[];
  sessionStatuses: Record<string, SessionStatus>;
  sessionActivities: Record<string, SessionActivity>;
  sendingPrompts: Record<string, true>;
  unreadSessionIds: ReadonlySet<string>;
}

/**
 * Whether a status node is lit: unread work below it, or in-flight activity of
 * any kind. The row and tab dots both draw on this.
 */
export function isNavigationActivityLit(flags: StatusFlags | undefined): boolean {
  return hasStatusUnread(flags) || statusActivityKind(flags) !== undefined;
}

/**
 * The clickable activity row: every lit project, named by its project, drawn
 * from the same selected-machine snapshot the lists render, so every item is
 * jumpable.
 */
export function navigationActivityItems(options: NavigationActivityOptions): NavigationActivityItem[] {
  const { machineId, snapshot, projects } = options;
  if (snapshot === undefined) return [];
  const items: NavigationActivityItem[] = [];
  for (const project of projects) {
    if (!isNavigationActivityLit(snapshot.projects[project.id])) continue;
    items.push({ machineId, projectId: project.id });
  }
  return items;
}

/**
 * The dot a desktop tab shows, resolving exactly what its list renders:
 * machines roll up every machine snapshot, projects and workspaces roll up the
 * listed rows' flags, and sessions resolve their own row indicators.
 */
export function navigationSectionActivity(section: NavigationSection, options: NavigationSectionActivityOptions): NavigationSectionActivity {
  switch (section) {
    case "machines":
      return flagsActivity(options.machines.map((machine) => options.machineStatusSnapshots[machine.id]?.machine));
    case "projects":
      return flagsActivity(options.projects.map((project) => options.snapshot?.projects[project.id]));
    case "workspaces":
      return flagsActivity(options.workspaces.map((workspace) => options.snapshot?.workspaces[workspace.id]));
    case "sessions":
      return sessionsActivity(options);
  }
}

@customElement("app-navigation-panel")
export class AppNavigationPanel extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selectedMachine?: Machine;
  /** PWA display mode: surfaces the single-machine identity bubble in the header. */
  @property({ type: Boolean }) locationIndicator = false;
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineStatusSnapshots: Record<string, MachineStatusSnapshot> = {};
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selectedProject?: Project;
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selectedWorkspace?: Workspace;
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) selectedSession?: SessionInfo;
  @property({ attribute: false }) sessionActivities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sessionStatuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) sendingPrompts: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) deletingWorkspaceIds: string[] = [];
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
  @property({ attribute: false }) refreshControl: unknown;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) compact = false;
  /** Desktop tabs: one row of sections above the lists, only the open tab's list rendered. */
  @property({ type: Boolean, reflect: true }) tabbed = false;
  @property({ type: Boolean }) machinesCollapsed = false;
  @property({ type: Boolean }) projectsCollapsed = false;
  @property({ type: Boolean }) workspacesCollapsed = false;
  @property({ type: Boolean }) sessionsCollapsed = false;
  @property({ type: Number }) startingSessionCount = 0;
  @property({ type: Boolean }) canStartSession = false;
  @property({ attribute: false }) onShowActions?: () => void;
  @property({ attribute: false }) onToggleMachines?: () => void;
  @property({ attribute: false }) onToggleProjects?: () => void;
  @property({ attribute: false }) onToggleWorkspaces?: () => void;
  @property({ attribute: false }) onToggleSessions?: () => void;
  @property({ attribute: false }) onSelectProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onSelectWorkspace?: (workspace: Workspace) => void | Promise<void>;
  @property({ attribute: false }) onDeleteWorkspace?: (workspace: Workspace) => void | Promise<void>;
  @property({ attribute: false }) onStartSession?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessionWithDescendants?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onRestoreSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteCachedNewSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onDetachParentSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionRead?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionsRead?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onReloadSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onCleanupSessions?: () => void | Promise<void>;
  @property({ attribute: false }) onArchivedCollapsed?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onRemoveMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNavigationTarget?: (target: NavigationFocusTarget) => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectTab?: (section: NavigationSection) => void;
  @property({ attribute: false }) onJumpToActivity?: (item: NavigationActivityItem) => void;

  @query("machine-list") private machineList?: KeyboardNavigableSection;
  @query("machine-switcher") private machineSwitcher?: KeyboardNavigableSection;
  @query("project-list") private projectList?: KeyboardNavigableSection;
  @query("workspace-list") private workspaceList?: KeyboardNavigableSection;
  @query("session-list") private sessionList?: KeyboardNavigableSection;

  async focusSection(section: NavigationSection): Promise<boolean> {
    await this.updateComplete;
    switch (section) {
      case "machines": return await this.focusNavigableSection(this.compact ? this.machineList : this.machineSwitcher);
      case "projects": return await this.focusNavigableSection(this.projectList);
      case "workspaces": return await this.focusNavigableSection(this.workspaceList);
      case "sessions": return await this.focusNavigableSection(this.sessionList);
    }
  }

  override render() {
    return html`
      <header>
        <strong>${this.selectedProject?.name ?? "PI WEB"}</strong>
        <machine-switcher
          .machines=${this.machines}
          .selected=${this.selectedMachine}
          .locationIndicator=${this.locationIndicator}
          .statuses=${this.machineStatuses}
          .statusSnapshots=${this.machineStatusSnapshots}
          .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
          .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
          .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
          .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
        ></machine-switcher>
        <div class="header-actions">
          ${this.refreshControl}
          <button title="Show Actions" aria-label="Show Actions" @click=${() => { this.onShowActions?.(); }}>Actions</button>
        </div>
      </header>
      ${this.tabbed ? this.renderActivityRow() : null}
      ${this.tabbed ? this.renderTabRow() : null}
      ${this.tabbed ? this.renderActiveSection() : this.renderStackedSections()}
    `;
  }

  /**
   * Project and workspace rows always belong to the selected machine, resolved
   * exactly as the rest of the app resolves it — including its local-machine
   * default, which is the key snapshots arrive under before a machine has been
   * selected. Diverging here would blank every row's indicator while a snapshot
   * is in fact loaded.
   */
  private selectedMachineStatusSnapshot(): MachineStatusSnapshot | undefined {
    return this.machineStatusSnapshots[selectedMachineId({ selectedMachine: this.selectedMachine })];
  }

  private activityItems(): NavigationActivityItem[] {
    return navigationActivityItems({
      machineId: selectedMachineId({ selectedMachine: this.selectedMachine }),
      snapshot: this.selectedMachineStatusSnapshot(),
      projects: this.projects,
    });
  }

  private renderActivityRow() {
    const items = this.activityItems();
    if (items.length === 0) return null;
    return html`<div class="activity-row" role="toolbar" aria-label="Active projects">
      ${items.map((item) => this.renderActivityChip(item))}
    </div>`;
  }

  private renderActivityChip(item: NavigationActivityItem) {
    const name = this.projects.find((project) => project.id === item.projectId)?.name ?? "";
    if (name === "") return null;
    const flags = this.selectedMachineStatusSnapshot()?.projects[item.projectId];
    const indicator = renderActivityIndicator(
      statusActivityKind(flags),
      "project active",
      hasStatusUnread(flags) ? "Unread in project" : undefined,
    );
    return html`<button class="activity-chip" title=${`Open project ${name}`} aria-label=${`Open project ${name}`} @click=${() => { this.onJumpToActivity?.(item); }}>${indicator}<span class="activity-chip-name">${name}</span></button>`;
  }

  private renderTabRow() {
    const active = this.activeTabSection();
    const tabs: { section: NavigationSection; name: string; letter: string }[] = [
      { section: "projects", name: "Projects", letter: "P" },
      { section: "workspaces", name: "Workspaces", letter: "W" },
      { section: "sessions", name: "Sessions", letter: "S" },
    ];
    return html`<nav class="section-tabs" aria-label="Sidebar sections">
      ${tabs.map((tab) => {
        const { kind, unread } = navigationSectionActivity(tab.section, this.sectionActivityOptions());
        return html`<button
          class=${`section-tab${tab.section === active ? " active" : ""}`}
          aria-pressed=${String(tab.section === active)}
          aria-label=${tab.name}
          title=${unread ? `Unread in ${tab.name}` : tab.name}
          @click=${() => { this.onSelectTab?.(tab.section); }}
        ><span class="section-tab-name">${tab.letter}</span>${renderActivityIndicator(kind, `${tab.name} active`, unread ? `Unread in ${tab.name}` : undefined)}</button>`;
      })}
    </nav>`;
  }

  private sectionActivityOptions(): NavigationSectionActivityOptions {
    return {
      machines: this.machines,
      machineStatusSnapshots: this.machineStatusSnapshots,
      snapshot: this.selectedMachineStatusSnapshot(),
      projects: this.projects,
      workspaces: this.workspaces,
      sessions: this.sessions,
      sessionStatuses: this.sessionStatuses,
      sessionActivities: this.sessionActivities,
      sendingPrompts: this.sendingPrompts,
      unreadSessionIds: this.unreadSessionIds,
    };
  }

  private renderStackedSections() {
    return html`
      ${this.compact && shouldShowMachinesSection(this.machines) ? this.renderMachineList() : null}
      ${this.renderProjectList()}
      ${this.renderWorkspaceList()}
      ${this.renderSessionList()}
    `;
  }

  /**
   * Desktop tabs show exactly one list: the open tab's. The tab row already
   * names every section, so the closed ones must not occupy panel height.
   */
  private renderActiveSection() {
    switch (this.activeTabSection()) {
      case "machines": return this.renderMachineList();
      case "projects": return this.renderProjectList();
      case "workspaces": return this.renderWorkspaceList();
      case "sessions": return this.renderSessionList();
    }
  }

  /**
   * The desktop tab that is open. The tab bar is projects/workspaces/sessions
   * only; machines never opens a tab (its switcher lives in the header).
   */
  private activeTabSection(): NavigationSection {
    const collapsed: Record<NavigationSection, boolean> = {
      machines: this.machinesCollapsed,
      projects: this.projectsCollapsed,
      workspaces: this.workspacesCollapsed,
      sessions: this.sessionsCollapsed,
    };
    return TAB_BAR_SECTIONS.find((section) => !collapsed[section]) ?? "projects";
  }

  private renderMachineList() {
    return html`
      <machine-list
        .machines=${this.machines}
        .selected=${this.selectedMachine}
        .statuses=${this.machineStatuses}
        .statusSnapshots=${this.machineStatusSnapshots}
        .collapsible=${this.collapsible}
        .collapsed=${this.machinesCollapsed}
        .onToggleCollapsed=${() => { this.onToggleMachines?.(); }}
        .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
        .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
        .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></machine-list>
    `;
  }

  private renderProjectList() {
    return html`
      <project-list
        .projects=${this.projects}
        .selected=${this.selectedProject}
        .statusSnapshot=${this.selectedMachineStatusSnapshot()}
        .collapsible=${this.collapsible}
        .collapsed=${this.projectsCollapsed}
        .onToggleCollapsed=${() => { this.onToggleProjects?.(); }}
        .onSelect=${(project: Project) => this.onSelectProject?.(project)}
        .onClose=${(project: Project) => this.onCloseProject?.(project)}
        .onFocusPreviousSection=${() => { this.focusPreviousFrom("projects"); }}
        .onFocusNextSection=${() => { this.focusNextFrom("projects"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></project-list>
    `;
  }

  private renderWorkspaceList() {
    return html`
      <workspace-list
        .workspaces=${this.workspaces}
        .selected=${this.selectedWorkspace}
        .machineId=${this.selectedMachine?.id ?? "local"}
        .statusSnapshot=${this.selectedMachineStatusSnapshot()}
        .deletingWorkspaceIds=${this.deletingWorkspaceIds}
        .collapsible=${this.collapsible}
        .collapsed=${this.workspacesCollapsed}
        .workspaceLabelItems=${this.workspaceLabelItems}
        .onToggleCollapsed=${() => { this.onToggleWorkspaces?.(); }}
        .onSelect=${(workspace: Workspace) => this.onSelectWorkspace?.(workspace)}
        .onDelete=${(workspace: Workspace) => this.onDeleteWorkspace?.(workspace)}
        .onFocusPreviousSection=${() => { this.focusPreviousFrom("workspaces"); }}
        .onFocusNextSection=${() => { this.focusNextFrom("workspaces"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></workspace-list>
    `;
  }

  private renderSessionList() {
    return html`
      <session-list
        .sessions=${this.sessions}
        .statuses=${this.sessionStatuses}
        .activities=${this.sessionActivities}
        .sending=${this.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selected=${this.selectedSession}
        .startingCount=${this.startingSessionCount}
        .canStart=${this.canStartSession}
        .collapsible=${this.collapsible}
        .collapsed=${this.sessionsCollapsed}
        .onToggleCollapsed=${() => { this.onToggleSessions?.(); }}
        .onArchivedCollapsed=${() => this.onArchivedCollapsed?.()}
        .onStart=${() => this.onStartSession?.()}
        .onSelect=${(session: SessionInfo) => this.onSelectSession?.(session)}
        .onArchive=${(session: SessionInfo) => this.onArchiveSession?.(session)}
        .onArchiveWithDescendants=${(session: SessionInfo) => this.onArchiveSessionWithDescendants?.(session)}
        .onArchiveMany=${(sessions: SessionInfo[]) => this.onArchiveSessions?.(sessions)}
        .onRestore=${(session: SessionInfo) => this.onRestoreSession?.(session)}
        .onDelete=${(session: SessionInfo) => this.onDeleteCachedNewSession?.(session)}
        .onDeleteArchived=${(session: SessionInfo) => this.onDeleteArchivedSession?.(session)}
        .onDeleteArchivedMany=${(sessions: SessionInfo[]) => this.onDeleteArchivedSessions?.(sessions)}
        .onDetachParent=${(session: SessionInfo) => this.onDetachParentSession?.(session)}
        .onMarkRead=${(session: SessionInfo) => this.onMarkSessionRead?.(session)}
        .onMarkReadMany=${(sessions: SessionInfo[]) => this.onMarkSessionsRead?.(sessions)}
        .onReload=${(session: SessionInfo) => this.onReloadSession?.(session)}
        .onCleanup=${() => this.onCleanupSessions?.()}
        .onFocusPreviousSection=${() => { this.focusPreviousFrom("sessions"); }}
        .onFocusNextSection=${() => { this.focusNextFrom("sessions"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></session-list>
    `;
  }

  private async focusNavigableSection(section: KeyboardNavigableSection | undefined): Promise<boolean> {
    if (section === undefined) return false;
    return await section.focusSelectedOrFirst();
  }

  private focusPreviousFrom(section: NavigationSection): void {
    const target = previousVisibleNavigationTarget(section, this.machines);
    if (target !== undefined) void this.onFocusNavigationTarget?.(target);
  }

  private focusNextFrom(section: NavigationSection): void {
    void this.onFocusNavigationTarget?.(nextVisibleNavigationTarget(section, this.machines));
  }

  private cancelKeyboardNavigation(): void {
    void this.onCancelKeyboardNavigation?.();
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    :host([compact]) { flex: 1 1 auto; }
    header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    header strong { flex: 0 0 auto; }
    machine-switcher { flex: 1 1 auto; min-width: 0; }
    :host([compact]) header { display: none; }
    .header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    /* The activity row and the tab row are fixed chrome; the open list gets
       every remaining pixel. */
    .activity-row { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .activity-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; font: inherit; cursor: pointer; }
    .activity-chip:hover { background: var(--pi-surface-hover); }
    .activity-chip .activity-indicator, .activity-chip .unread-ring { margin: 0; }
    .activity-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .section-tabs { flex: 0 0 auto; display: flex; align-items: stretch; gap: 6px; padding: 0 12px 10px; }
    .section-tab { position: relative; flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; padding: 8px 6px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); font: inherit; cursor: pointer; }
    .section-tab:hover { background: var(--pi-surface-hover); }
    .section-tab.active { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .section-tab-name { font-weight: 600; font-size: 13px; line-height: 1; }
    /* Activity dots are fixed corner badges: absolutely positioned so their
       presence or absence never changes the button size. */
    .section-tab .activity-indicator, .section-tab .unread-ring { position: absolute; top: 4px; right: 5px; margin: 0; vertical-align: 0; }
    .section-tab .activity-indicator { width: 8px; height: 8px; border-radius: 50%; background: var(--pi-success); }
    .section-tab .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
    .section-tab .activity-indicator.sending { background: var(--pi-warning); }
    .section-tab .activity-indicator.unread { background: var(--pi-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--pi-accent) 20%, transparent); }
    .section-tab .unread-ring { display: grid; place-items: center; width: 10px; height: 10px; border: 1.5px solid var(--pi-accent); border-radius: 50%; }
    .section-tab .unread-ring .activity-indicator { position: static; width: 5px; height: 5px; border-radius: 50%; background: var(--pi-accent); box-shadow: none; }
    /* Expanded sections share the panel height equally, so collapsing one
       section distributes its space to every remaining section, not just the
       session list. Collapsed sections keep only their heading height. */
    machine-list, project-list, workspace-list, session-list { flex: 1 1 0px; min-height: 0; overflow: hidden; border-bottom: 1px solid var(--pi-border-muted); }
    machine-list[collapsed],
    project-list[collapsed],
    workspace-list[collapsed],
    session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    /* Tabbed desktop renders exactly one list, so its heading is the section's
       own operation row, on its own line under the tab row. */
    :host([tabbed]) machine-list, :host([tabbed]) project-list, :host([tabbed]) workspace-list, :host([tabbed]) session-list { border-bottom: 0; }
  `;
}

export function shouldShowMachinesSection(machines: readonly Machine[]): boolean {
  return machines.length > 1;
}

/** The desktop tab bar: one letter per section, machines never tabbed. */
const TAB_BAR_SECTIONS = ["projects", "workspaces", "sessions"] as const satisfies readonly NavigationSection[];

function previousVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationSection | undefined {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) - 1];
}

function nextVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationFocusTarget {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) + 1] ?? "chat";
}

// Only a machine choice makes the machines section navigable: with a single
// machine the switcher is a static bubble, and compact mode has no list.
function visibleNavigationSections(machines: readonly Machine[]): NavigationSection[] {
  return NAVIGATION_SECTION_ORDER.filter((section) => section !== "machines" || shouldShowMachinesSection(machines));
}

function flagsActivity(flagLists: readonly (StatusFlags | undefined)[]): NavigationSectionActivity {
  const rolled = rollUpStatusFlags(flagLists.filter((flags): flags is StatusFlags => flags !== undefined));
  return { kind: statusActivityKind(rolled), unread: hasStatusUnread(rolled) };
}

function sessionsActivity(options: NavigationSectionActivityOptions): NavigationSectionActivity {
  let kind: ActivityIndicatorKind | undefined;
  let unread = false;
  for (const session of options.sessions) {
    kind ??= sessionRowActivityKind(session, options.sessionStatuses[session.id], options.sessionActivities[session.id], options.sendingPrompts[session.id] === true);
    if (!unread && sessionRowUnread(session, options.unreadSessionIds)) unread = true;
  }
  return { kind, unread };
}
