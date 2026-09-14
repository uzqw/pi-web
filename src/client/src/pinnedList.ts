import { css, html, type ReactiveController, type ReactiveControllerHost, type TemplateResult } from "lit";

/**
 * Pin state for a flat sidebar list (projects, workspaces, sessions). Pin order
 * is significant: index 0 is the top row, so a newly pinned item sits above
 * every earlier pin ("later pins win"). Only pinned rows are draggable, and
 * unpinning returns the item to its natural position in the list.
 */

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

export function loadPinnedIds(storageKey: string, storage = browserStorage()): string[] {
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

export function savePinnedIds(storageKey: string, ids: readonly string[], storage = browserStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

/** Pin an item at the top, or remove it when it is already pinned. */
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

export class PinnedListController implements ReactiveController {
  private idsValue: readonly string[];
  private dragIdValue: string | undefined;
  private dragOverIdValue: string | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly storageKey: string,
    private readonly storage: PinStorage | undefined = browserStorage(),
  ) {
    this.idsValue = loadPinnedIds(storageKey, storage);
    host.addController(this);
  }

  hostConnected(): void {
    return;
  }

  get ids(): readonly string[] {
    return this.idsValue;
  }

  get dragId(): string | undefined {
    return this.dragIdValue;
  }

  get dragOverId(): string | undefined {
    return this.dragOverIdValue;
  }

  isPinned(id: string): boolean {
    return this.idsValue.includes(id);
  }

  toggle(id: string): void {
    this.setIds(togglePinnedId(this.idsValue, id));
  }

  /**
   * Split a list into pinned items (in pin order) and the rest (original
   * order). Ids with no matching item are skipped, so a pin for a deleted item
   * simply disappears without pruning storage.
   */
  partition<T>(items: readonly T[], getId: (item: T) => string): { pinned: T[]; rest: T[] } {
    const byId = new Map(items.map((item) => [getId(item), item]));
    const pinned: T[] = [];
    const pinnedIds = new Set<string>();
    for (const id of this.idsValue) {
      const item = byId.get(id);
      if (item === undefined) continue;
      pinned.push(item);
      pinnedIds.add(id);
    }
    return { pinned, rest: items.filter((item) => !pinnedIds.has(getId(item))) };
  }

  handleDragStart(event: DragEvent, id: string): void {
    if (!this.isPinned(id)) return;
    this.dragIdValue = id;
    event.dataTransfer?.setData("text/plain", id);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
    this.host.requestUpdate();
  }

  handleDragOver(event: DragEvent, id: string): void {
    const fromId = this.dragIdValue;
    if (fromId === undefined || fromId === id || !this.isPinned(id)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    if (this.dragOverIdValue === id) return;
    this.dragOverIdValue = id;
    this.host.requestUpdate();
  }

  handleDrop(event: DragEvent, id: string): void {
    if (!this.isPinned(id)) return;
    event.preventDefault();
    const fromId = this.dragIdValue;
    this.dragIdValue = undefined;
    this.dragOverIdValue = undefined;
    if (fromId === undefined || fromId === id) {
      this.host.requestUpdate();
      return;
    }
    this.setIds(movePinnedId(this.idsValue, fromId, id));
  }

  handleDragEnd(): void {
    this.dragIdValue = undefined;
    this.dragOverIdValue = undefined;
    this.host.requestUpdate();
  }

  private setIds(ids: string[]): void {
    this.idsValue = ids;
    savePinnedIds(this.storageKey, ids, this.storage);
    this.host.requestUpdate();
  }
}

const pinGlyph = html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>`;

/** Icon-only pin toggle. `label` names the row for the tooltip. */
export function renderPinToggle(pins: PinnedListController, id: string, label: string): TemplateResult {
  const pinned = pins.isPinned(id);
  return html`<button
    class="action-pin-toggle ${pinned ? "pinned" : ""}"
    title=${pinned ? `Unpin ${label}` : `Pin ${label} to top`}
    aria-pressed=${String(pinned)}
    @click=${(event: MouseEvent) => { event.stopPropagation(); pins.toggle(id); }}
  >${pinGlyph}</button>`;
}

/**
 * Trailing-column styling for a row that stacks the pin toggle above the
 * actions menu. Append after `listStyles`.
 */
export const pinnedListStyles = css`
  .action-menu { position: relative; align-self: stretch; display: flex; flex-direction: column; }
  .action-menu > .action-pin-toggle { display: grid; place-items: center; flex: 0 0 auto; box-sizing: border-box; height: 20px; min-width: 32px; padding: 0; color: var(--pi-muted); border-left: 0; border-bottom: 0; border-radius: 0 8px 0 0; }
  .action-pin-toggle svg { width: 14px; height: 14px; fill: currentColor; }
  .action-menu > .action-menu-toggle { display: grid; place-items: center; flex: 1 1 auto; box-sizing: border-box; height: auto; min-width: 32px; padding: 0; color: var(--pi-muted); border-left: 0; border-radius: 0 0 8px 0; }
  .action-menu > .action-menu-toggle.solo { border-radius: 0 8px 8px 0; }
  .action-pin-toggle:not(.pinned) { opacity: .55; }
  .action-pin-toggle:not(.pinned):hover { color: var(--pi-text); background: var(--pi-surface-hover); opacity: 1; }
  .action-row.selected .action-pin-toggle { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  /* A pinned row gets a solid accent fill so the state reads at a glance, even on the selected row. */
  .action-row .action-pin-toggle.pinned, .action-row .action-pin-toggle.pinned:hover { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-bg); opacity: 1; }
  .action-row.pinned { cursor: grab; }
  .action-row.pinned.dragging { opacity: .5; }
  .action-row.pinned.drag-over { box-shadow: inset 0 2px 0 var(--pi-accent); }
`;
