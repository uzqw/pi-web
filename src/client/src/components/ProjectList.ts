import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { actionMenuPanelStyle } from "./actionMenu";
import { hasStatusUnread, renderActionActivityIndicator, statusActivityKind } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { PinnedListController, pinnedListStyles, renderPinToggle } from "../pinnedList";
import { listStyles } from "./shared";

@customElement("project-list")
export class ProjectList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  /** Status tree of the machine these projects belong to; absent means no indicators. */
  @property({ attribute: false }) statusSnapshot: MachineStatusSnapshot | undefined;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @property({ attribute: false }) pinnedIds: readonly string[] = [];
  @property({ attribute: false }) onChangePinnedIds?: (ids: string[]) => void;
  @state() private openMenuProjectId: string | undefined;
  @state() private menuStyle = "";
  private readonly pins = new PinnedListController(this, (ids) => { this.onChangePinnedIds?.(ids); });
  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuProjectId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("pinnedIds")) this.pins.setIds(this.pinnedIds);
    if (changed.has("projects") && this.openMenuProjectId !== undefined && !this.projects.some((project) => project.id === this.openMenuProjectId)) this.openMenuProjectId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    const { pinned, rest } = this.pins.partition(this.projects, (project) => project.id);
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${pinned.map((project) => this.renderProject(project, true))}
            ${rest.map((project) => this.renderProject(project, false))}
          </div>
        `}
      </section>
    `;
  }

  private renderProject(project: Project, pinned: boolean) {
    return html`
      <div
        class=${`action-row ${this.selected?.id === project.id ? "selected" : ""} ${pinned ? "pinned" : ""} ${pinned && this.pins.dragOverId === project.id ? "drag-over" : ""} ${pinned && this.pins.dragId === project.id ? "dragging" : ""}`}
        tabindex="0"
        title=${project.path}
        .draggable=${pinned}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(project)); }}
        @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
        @dragstart=${(event: DragEvent) => { this.pins.handleDragStart(event, project.id); }}
        @dragover=${(event: DragEvent) => { this.pins.handleDragOver(event, project.id); }}
        @drop=${(event: DragEvent) => { this.pins.handleDrop(event, project.id); }}
        @dragend=${() => { this.pins.handleDragEnd(); }}
      >
        <div class="action-main">
          <span class="workspace-primary"><span class="workspace-primary-label">${project.name}</span></span><small>${project.path}</small>
          ${this.renderActivity(project)}
        </div>
        <div class="action-menu">
          ${renderPinToggle(this.pins, project.id, project.name)}
          <button class="action-menu-toggle" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuProjectId === project.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  private handleProjectKeydown(event: KeyboardEvent, project: Project): void {
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(project),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>Projects</span>`;
    const selectedSummary = this.selected?.name ?? "No project selected";
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Projects</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${this.projects.length}</small></button>`;
  }

  private renderActivity(project: Project) {
    const flags = this.statusSnapshot?.projects[project.id];
    const kind = statusActivityKind(flags);
    const unreadLabel = hasStatusUnread(flags) ? "Unread sessions in this project" : undefined;
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active", unreadLabel);
  }

  private toggleMenu(projectId: string, target: EventTarget | null) {
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuProjectId = projectId;
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(`Close ${project.name}?\n\nThis only removes it from PI WEB; it will not change the project folder.`)) this.onClose?.(project);
  }

  static override styles = [listStyles, pinnedListStyles];
}
