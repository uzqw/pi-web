import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SubagentProgressChild, SubagentRunProgress, SubagentRunState } from "../../../shared/apiTypes";
import type { ToolExecutionPart } from "./shared";
import { subagentApi } from "../api/clients";
import { HttpRequestError } from "../api/http";

const POLL_INTERVAL_MS = 2_000;
/**
 * A dispatch card mounts as soon as the tool call returns, while the runtime may still
 * be creating the run directory, so the first 404s are expected and worth retrying.
 */
const NOT_FOUND_RETRY_BASE_MS = 500;
const NOT_FOUND_RETRY_MAX_MS = 4_000;
const NOT_FOUND_MAX_RETRIES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTerminal(state: SubagentRunState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

/** 500ms, 1s, 2s, 4s, 4s: a run that is still missing after that is not going to appear. */
function notFoundRetryDelay(retries: number): number {
  return Math.min(NOT_FOUND_RETRY_BASE_MS * 2 ** retries, NOT_FOUND_RETRY_MAX_MS);
}

/**
 * The async run id behind a `subagent` tool card, if it has one. A foreground call
 * finishes inside the tool call itself and leaves no id; an async dispatch does.
 */
export function asyncSubagentRunId(execution: ToolExecutionPart): string | undefined {
  if (execution.toolName !== "subagent" || !isRecord(execution.details)) return undefined;
  const runId = execution.details["asyncId"];
  return typeof runId === "string" && runId !== "" ? runId : undefined;
}

/** Header label for one lane's elapsed time; sub-second precision only matters at the start. */
export function subagentElapsedLabel(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes)}m ${String(totalSeconds % 60)}s`;
}

/**
 * Live per-lane progress for one async subagent run.
 *
 * The run's own status file is the source of truth, so this element only polls the
 * host route while the run is live and renders nothing at all when the host has no
 * such run: a chat card must never reserve space for progress that may not exist.
 */
@customElement("subagent-progress")
export class SubagentProgressView extends LitElement {
  @property({ attribute: false }) runId: string | undefined;
  @state() private progress: SubagentRunProgress | undefined;
  /** Run the timer and any in-flight request belong to; cleared on unmount. */
  private activeRunId: string | undefined;
  private pollTimer: number | undefined;
  /** Consecutive 404s for the active run: a retry budget, not an open-ended loop. */
  private missingRetries = 0;
  /** The active run has a final answer, so no timer may be armed again for it. */
  private settled = false;
  /** Run with a request open, so a new answer never overlaps the one already on the wire. */
  private inFlightRunId: string | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.syncPolling();
  }

  override disconnectedCallback(): void {
    this.activeRunId = undefined;
    this.stopTimer();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("runId")) this.syncPolling();
  }

  override render() {
    const progress = this.progress;
    if (progress === undefined) return null;
    // A run whose status file is too large to read still exists; an empty card would
    // read as "nothing was dispatched".
    if (progress.children.length === 0 && progress.statusOversized !== true) return null;
    return html`
      <section class="subagent-progress" aria-label="Subagent progress">
        <div class="subagent-header">
          <span>Subtasks · ${String(progress.children.length)}</span>
          <span class=${`subagent-state ${progress.state}`}>${progress.state}</span>
        </div>
        ${progress.children.length === 0
          ? html`<span class="lane-note">Status file too large to read</span>`
          : html`<ul class="subagent-lanes">
              ${progress.children.map((child) => this.renderChild(child))}
            </ul>`}
      </section>
    `;
  }

  private renderChild(child: SubagentProgressChild) {
    const elapsed = child.elapsedMs === undefined ? undefined : subagentElapsedLabel(child.elapsedMs);
    return html`
      <li class=${`subagent-lane ${child.status}`}>
        <span class="lane-dot" aria-hidden="true"></span>
        <span class="lane-label" title=${child.label}>${child.label}</span>
        <span class="sr-only">${child.status}</span>
        ${elapsed === undefined ? null : html`<span class="lane-elapsed">${elapsed}</span>`}
        ${child.lastTool === undefined ? null : html`<span class="lane-tool" title=${`Last tool: ${child.lastTool}`}>${child.lastTool}</span>`}
        ${child.lastText === undefined ? null : html`<span class=${`lane-text ${child.isError === true ? "error" : ""}`} title=${child.lastText}>${child.lastText}</span>`}
      </li>
    `;
  }

  private syncPolling(): void {
    const runId = this.runId === undefined || this.runId === "" ? undefined : this.runId;
    if (!this.isConnected || runId === undefined) {
      this.activeRunId = undefined;
      this.progress = undefined;
      this.stopTimer();
      return;
    }
    // An unchanged run keeps its timer, its settled verdict, and its in-flight request.
    if (runId === this.activeRunId) return;
    this.activeRunId = runId;
    this.progress = undefined;
    this.missingRetries = 0;
    this.settled = false;
    this.stopTimer();
    void this.refresh();
  }

  private readonly onVisibilityChange = (): void => {
    // A hidden tab arms no timer; coming back must not wait a full interval for the
    // first answer, so it refreshes right away instead.
    if (document.visibilityState === "hidden" || this.settled) return;
    if (this.pollTimer !== undefined) return;
    void this.refresh();
  };

  private async refresh(): Promise<void> {
    const runId = this.activeRunId;
    if (runId === undefined || this.inFlightRunId === runId) return;
    this.inFlightRunId = runId;
    try {
      let progress: SubagentRunProgress;
      try {
        progress = await subagentApi.progress(runId);
      } catch (error) {
        if (this.activeRunId !== runId) return;
        if (error instanceof HttpRequestError && error.status === 404) {
          this.missingRetries += 1;
          this.progress = undefined;
          if (this.missingRetries > NOT_FOUND_MAX_RETRIES) {
            // The run directory never appeared on this host: stop instead of asking forever.
            this.settled = true;
            this.stopTimer();
            return;
          }
          this.schedule(notFoundRetryDelay(this.missingRetries - 1));
          return;
        }
        // Anything else (web host restarting, malformed frame) is transient: keep the
        // rows already shown and retry on the next tick.
        this.schedule(POLL_INTERVAL_MS);
        return;
      }
      if (this.activeRunId !== runId) return;
      this.missingRetries = 0;
      this.progress = progress;
      if (isTerminal(progress.state)) {
        this.settled = true;
        this.stopTimer();
        return;
      }
      this.schedule(POLL_INTERVAL_MS);
    } finally {
      if (this.inFlightRunId === runId) this.inFlightRunId = undefined;
    }
  }

  private schedule(delayMs: number): void {
    this.stopTimer();
    // A hidden tab polls nothing: the browser throttles it anyway, and the answer can
    // only be seen after the tab comes back, which refreshes immediately.
    if (!this.isConnected || this.settled || document.visibilityState === "hidden") return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  private stopTimer(): void {
    if (this.pollTimer === undefined) return;
    window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  static override styles = css`
    :host { display: block; width: 100%; max-width: 100%; min-width: 0; }
    .subagent-progress { display: grid; gap: 6px; min-width: 0; border-top: 1px solid var(--pi-border-muted); padding-top: 7px; color: var(--pi-muted); font-size: 12px; }
    .subagent-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
    .subagent-header > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .subagent-state { flex: 0 0 auto; text-transform: uppercase; letter-spacing: .04em; color: var(--pi-muted); }
    .subagent-state.running { color: var(--pi-warning); }
    .subagent-state.completed { color: var(--pi-success); }
    .subagent-state.failed { color: var(--pi-danger); }
    .subagent-lanes { display: grid; gap: 4px; max-height: 220px; margin: 0; padding: 0; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-width: thin; list-style: none; }
    .subagent-lane { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
    .lane-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--pi-dim); }
    .subagent-lane.running .lane-dot { background: var(--pi-warning); }
    .subagent-lane.completed .lane-dot { background: var(--pi-success); }
    .subagent-lane.failed .lane-dot { background: var(--pi-danger); }
    .subagent-lane.stopped .lane-dot { background: var(--pi-muted); }
    .lane-label { flex: 0 0 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-text); }
    .lane-elapsed, .lane-tool { flex: 0 0 auto; color: var(--pi-muted); font: inherit; }
    .lane-tool { color: var(--pi-accent); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .lane-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .lane-text.error { color: var(--pi-danger); }
    .lane-note { color: var(--pi-muted); font-style: italic; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
}
