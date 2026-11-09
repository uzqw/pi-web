import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionSubagentRun, SubagentProgressChild, SubagentRunState } from "../../../shared/apiTypes";
import { subagentApi } from "../api/clients";
import { subagentElapsedLabel } from "./SubagentProgressView";

const LIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;
/** Runs are worth showing for a while after they finish, then the chat card is history. */
const RECENT_RUN_MS = 10 * 60 * 1_000;
const COLLAPSED_STORAGE_KEY = "pi-web.subagent-runs-dock.collapsed";

function isTerminal(state: SubagentRunState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function runSummary(runs: readonly SessionSubagentRun[]): string {
  const live = runs.filter((run) => !isTerminal(run.state)).length;
  const runsLabel = `${String(runs.length)} run${runs.length === 1 ? "" : "s"}`;
  return live === 0 ? `Subtasks · ${runsLabel} · done` : `Subtasks · ${runsLabel} · ${String(live)} running`;
}

/**
 * The composer dock for async subagent runs.
 *
 * A dispatch card scrolls away with its turn, so the place to watch a run is right
 * above the composer: this element asks the host which runs belong to the open
 * session and polls them while anything is still running. It renders nothing when
 * the session has no recent run, so a quiet session loses no vertical space.
 */
@customElement("subagent-runs-dock")
export class SubagentRunsDock extends LitElement {
  @property({ attribute: false }) sessionId: string | undefined;
  /**
   * Whether the loaded transcript holds an async subagent dispatch. Without one the
   * dock must not touch the network: most sessions never dispatch a subagent, and an
   * idle chat should stay silent.
   */
  @property({ attribute: false }) hasAsyncDispatches = false;
  @state() private runs: SessionSubagentRun[] = [];
  @state() private collapsed = readCollapsed();
  /** Session whose runs are loaded; the poll belongs to exactly one session at a time. */
  private activeSessionId: string | undefined;
  private timer: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncSession();
  }

  override disconnectedCallback(): void {
    this.stopTimer();
    this.activeSessionId = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("sessionId") || changed.has("hasAsyncDispatches")) this.syncSession();
  }

  override render() {
    const runs = this.visibleRuns();
    if (runs.length === 0) return null;
    const live = runs.some((run) => !isTerminal(run.state));
    return html`
      <section class="dock" aria-label="Subagent runs">
        <button
          type="button"
          class="dock-head"
          aria-expanded=${String(!this.collapsed)}
          aria-controls="subagent-runs-dock-body"
          @click=${() => { this.toggleCollapsed(); }}
        >
          <span class=${`dock-dot${live ? " live" : ""}`} aria-hidden="true"></span>
          <span class="dock-title">${runSummary(runs)}</span>
          <span class="dock-chevron" aria-hidden="true">${this.collapsed ? "▸" : "▾"}</span>
        </button>
        ${this.collapsed ? null : html`
          <div class="dock-body" id="subagent-runs-dock-body">
            ${runs.map((run) => this.renderRun(run))}
          </div>
        `}
      </section>
    `;
  }

  private renderRun(run: SessionSubagentRun) {
    const elapsed = run.totalMs === undefined ? undefined : subagentElapsedLabel(run.totalMs);
    return html`
      <article class=${`dock-run ${run.state}`}>
        <div class="run-head">
          <span class="run-mode" title=${run.runId}>${run.mode}</span>
          <span class=${`run-state ${run.state}`}>${run.state}</span>
          ${elapsed === undefined ? null : html`<span class="run-elapsed">${elapsed}</span>`}
        </div>
        ${run.children.length === 0 ? null : html`<ul class="lanes">${run.children.map((child) => this.renderLane(child))}</ul>`}
      </article>
    `;
  }

  private renderLane(child: SubagentProgressChild) {
    const elapsed = child.elapsedMs === undefined ? undefined : subagentElapsedLabel(child.elapsedMs);
    return html`
      <li class=${`lane ${child.status}`}>
        <span class="lane-dot" aria-hidden="true"></span>
        <span class="lane-label" title=${child.label}>${child.label}</span>
        <span class="sr-only">${child.status}</span>
        ${elapsed === undefined ? null : html`<span class="lane-elapsed">${elapsed}</span>`}
        ${child.lastTool === undefined ? null : html`<span class="lane-tool">${child.lastTool}</span>`}
        ${child.lastText === undefined ? null : html`<span class=${`lane-text${child.isError === true ? " error" : ""}`} title=${child.lastText}>${child.lastText}</span>`}
      </li>
    `;
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    try {
      globalThis.localStorage.setItem(COLLAPSED_STORAGE_KEY, this.collapsed ? "1" : "0");
    } catch {
      // A browser that refuses storage keeps the session-scoped state in memory only.
    }
  }

  /** Runs worth showing: anything live, plus what finished in the last few minutes. */
  private visibleRuns(): SessionSubagentRun[] {
    const cutoff = Date.now() - RECENT_RUN_MS;
    const runs = this.runs.filter((run) => {
      if (!isTerminal(run.state)) return true;
      const finishedAt = run.updatedAt ?? run.startedAt ?? 0;
      return finishedAt >= cutoff;
    });
    return [...runs].sort((left, right) => {
      const leftLive = isTerminal(left.state) ? 1 : 0;
      const rightLive = isTerminal(right.state) ? 1 : 0;
      return leftLive - rightLive || (right.startedAt ?? 0) - (left.startedAt ?? 0);
    });
  }

  private syncSession(): void {
    const sessionId = this.hasAsyncDispatches && this.sessionId !== undefined && this.sessionId !== "" ? this.sessionId : undefined;
    if (!this.isConnected || sessionId === undefined) {
      this.stopTimer();
      this.activeSessionId = undefined;
      this.runs = [];
      return;
    }
    if (sessionId === this.activeSessionId) return;
    this.activeSessionId = sessionId;
    this.runs = [];
    this.stopTimer();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (sessionId === undefined) return;
    try {
      const response = await subagentApi.sessionRuns(sessionId);
      if (this.activeSessionId !== sessionId) return;
      this.runs = response.runs;
    } catch {
      // A restarting host or a dropped request is transient: keep the last rows and retry.
    }
    if (this.activeSessionId !== sessionId) return;
    const live = this.runs.some((run) => !isTerminal(run.state));
    this.schedule(live ? LIVE_POLL_MS : IDLE_POLL_MS);
  }

  private schedule(delayMs: number): void {
    this.stopTimer();
    if (!this.isConnected) return;
    this.timer = window.setTimeout(() => { void this.refresh(); }, delayMs);
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; min-width: 0; }
    .dock { border-top: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    .dock-head {
      display: flex; align-items: baseline; gap: 8px; width: 100%; min-width: 0;
      padding: 5px 14px; border: 0; border-radius: 0; background: transparent;
      color: var(--pi-muted); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
    }
    .dock-head:hover { background: var(--pi-surface-hover, transparent); }
    .dock-head:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .dock-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--pi-dim); align-self: center; }
    .dock-dot.live { background: var(--pi-warning); }
    .dock-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dock-chevron { flex: 0 0 auto; color: var(--pi-muted); }
    .dock-body { display: grid; gap: 6px; max-height: 34vh; padding: 0 14px 10px; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-width: thin; }
    .dock-run { display: grid; gap: 3px; min-width: 0; padding: 5px 0; border-top: 1px solid var(--pi-border-muted); }
    .dock-run:first-child { border-top: 0; }
    .run-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .run-mode { flex: 0 0 auto; color: var(--pi-muted); }
    .run-state { flex: 0 0 auto; }
    .run-state.running { color: var(--pi-warning); }
    .run-state.completed { color: var(--pi-success); }
    .run-state.failed { color: var(--pi-danger); }
    .run-elapsed { flex: 0 0 auto; margin-left: auto; text-transform: none; letter-spacing: 0; }
    .lanes { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .lane { display: flex; align-items: baseline; gap: 7px; min-width: 0; font-size: 12px; color: var(--pi-muted); }
    .lane-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--pi-dim); align-self: center; }
    .lane.running .lane-dot { background: var(--pi-warning); }
    .lane.completed .lane-dot { background: var(--pi-success); }
    .lane.failed .lane-dot { background: var(--pi-danger); }
    .lane.stopped .lane-dot { background: var(--pi-muted); }
    .lane-label { flex: 0 0 auto; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-text); }
    .lane-elapsed { flex: 0 0 auto; }
    .lane-tool { flex: 0 0 auto; color: var(--pi-accent); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .lane-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lane-text.error { color: var(--pi-danger); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
}
