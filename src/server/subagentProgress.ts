import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionSubagentRunsResponse, SubagentProgressChild, SubagentRunProgress, SubagentRunState } from "../shared/apiTypes.js";

const RUN_GROUP_PREFIX = "pi-subagents-";
const RUNS_DIRECTORY = "async-subagent-runs";
const STATUS_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_TAIL_MAX_BYTES = 256 * 1024;
const LAST_TEXT_MAX_LENGTH = 160;
const TRUNCATION_RESERVE = 3;
/** One lane read per session log; a wide workflow holds dozens, so they fan out bounded. */
const LANE_READ_CONCURRENCY = 6;
/** Steady-state polling repeats one question per run every couple of seconds; keep the answer per status write. */
const SNAPSHOT_CACHE_MAX_ENTRIES = 64;
/** Runs whose state lives on this host; another machine's runs are not readable from here. */
const LOCAL_MACHINE_ID = "local";
/** The composer dock lists the newest handful of a session's runs; older ones stay in the chat. */
const MAX_SESSION_RUNS = 8;
/**
 * A run id must be a UUID shape before it may reach the filesystem: 36 hex-or-dash
 * characters cannot encode a separator, a drive letter, or `..`, so the scan below
 * never leaves the run root. Clients therefore never supply a path, only an id.
 */
const RUN_ID_PATTERN = /^[0-9a-f-]{36}$/i;

const RUN_STATE_BY_STATUS: Record<string, SubagentRunState> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  complete: "completed",
  failed: "failed",
  stopped: "stopped",
  aborted: "stopped",
};

export interface SubagentProgressOptions {
  /** Directory that holds the `pi-subagents-*` run groups; tests inject a fixture root. */
  runsRoot?: string;
  now?: () => number;
}

/** One run of a session, as the composer dock lists it. */
export interface SessionSubagentRun extends SubagentRunProgress {
  /** Launch shape the runtime recorded: `single`, `workflow`, … */
  mode: string;
}

interface BoundedRead {
  text: string;
  mtimeMs: number;
  /** The file was longer than the read budget, so `text` holds only its tail. */
  oversized: boolean;
}

/**
 * One `status.json` write, plus the lane detail read from its session logs on demand.
 *
 * The route is polled every couple of seconds per run, and a run's status file only
 * changes when the runtime writes it, so the parsed status and the lane reads are kept
 * per file write: an unchanged status file costs one `stat`, not a parse and a set of
 * log reads.
 */
interface RunSnapshot {
  mtimeMs: number;
  sizeBytes: number;
  status: Record<string, unknown> | undefined;
  /** The status file exceeded the read budget, so its fields may be incomplete. */
  oversized: boolean;
  /** Filled by `loadLanes`; the dock filters runs by session before it needs lanes. */
  lanes: LaneSnapshot[] | undefined;
}

/** What one lane says independent of the wall clock; only its elapsed time moves. */
interface LaneSnapshot {
  child: Omit<SubagentProgressChild, "elapsedMs">;
  durationMs: number | undefined;
  endedAt: number | undefined;
  /** Last write to the lane's session log: the end stamp of a finished lane without one. */
  sessionMtimeMs: number | undefined;
}

const snapshotCache = new Map<string, RunSnapshot>();

interface SessionTailUsage {
  toolCount: number;
  lastTool: string | undefined;
  lastText: string | undefined;
  isError: boolean | undefined;
}

/**
 * Run directory for `runId`, or undefined when no live or retained async subagent
 * run owns that id. The subagents runtime keeps its state under the host temp
 * directory, one group per user id.
 */
export async function findRunDir(runId: string, options: SubagentProgressOptions = {}): Promise<string | undefined> {
  if (!RUN_ID_PATTERN.test(runId)) return undefined;
  const runsRoot = options.runsRoot ?? tmpdir();
  for (const runDir of await listRunDirs(runsRoot)) {
    // The status file, not directory presence, proves an attempt actually started.
    if (basename(runDir) === runId) return runDir;
  }
  return undefined;
}

/** Every run directory under the host's run groups that has a status file. */
async function listRunDirs(runsRoot: string): Promise<string[]> {
  let groups: string[];
  try {
    groups = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_GROUP_PREFIX))
      .map((entry) => join(runsRoot, entry.name));
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const group of groups) {
    let entries;
    try {
      entries = await readdir(join(group, RUNS_DIRECTORY), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(group, RUNS_DIRECTORY, entry.name);
      if (await isFile(join(runDir, "status.json"))) dirs.push(runDir);
    }
  }
  return dirs;
}

/**
 * Per-lane progress for one subagent run, read from the run's own status file and
 * the tail of each child session log. Every read degrades to empty fields: this
 * feeds a passive chat card, so a missing or half-written file must never fail the
 * request that carries it.
 */
export async function readSubagentProgress(runId: string, options: SubagentProgressOptions = {}): Promise<SubagentRunProgress | undefined> {
  const runDir = await findRunDir(runId, options);
  if (runDir === undefined) return undefined;

  const snapshot = await loadRunSnapshot(runDir);
  return progressFromSnapshot(runId, snapshot, await loadLanes(snapshot), (options.now ?? Date.now)());
}

/**
 * Every async subagent run that belongs to `sessionId`, newest first.
 *
 * The runtime writes the parent's session file into each run's status record, so a
 * run is matched by its own metadata and never by the client's guess. This feeds the
 * composer dock: it has to know what is running without the chat having scrolled the
 * dispatch card into view.
 */
export async function listSessionSubagentRuns(sessionId: string, options: SubagentProgressOptions = {}): Promise<SessionSubagentRun[]> {
  if (!RUN_ID_PATTERN.test(sessionId)) return [];
  const runsRoot = options.runsRoot ?? tmpdir();
  // Which runs belong to the session is answered by the status file alone, so the
  // session logs of runs the dock never shows are not read at all.
  const matches: { runId: string; snapshot: RunSnapshot }[] = [];
  for (const runDir of await listRunDirs(runsRoot)) {
    const snapshot = await loadRunSnapshot(runDir);
    const parentSession = optionalString(snapshot.status, "sessionId");
    if (parentSession?.includes(sessionId) !== true) continue;
    matches.push({ runId: optionalString(snapshot.status, "runId") ?? basename(runDir), snapshot });
  }
  matches.sort((left, right) => (optionalNumber(right.snapshot.status, "startedAt") ?? 0) - (optionalNumber(left.snapshot.status, "startedAt") ?? 0));
  const now = (options.now ?? Date.now)();
  const runs: SessionSubagentRun[] = [];
  for (const { runId, snapshot } of matches.slice(0, MAX_SESSION_RUNS)) {
    runs.push({ ...progressFromSnapshot(runId, snapshot, await loadLanes(snapshot), now), mode: optionalString(snapshot.status, "mode") ?? "single" });
  }
  return runs;
}

/**
 * The status view of one run, re-read only when the file was written again. Polling
 * this route every couple of seconds is the steady state, and a run whose status file
 * has not changed must not cost a parse and a set of session log reads each time.
 */
async function loadRunSnapshot(runDir: string): Promise<RunSnapshot> {
  const path = join(runDir, "status.json");
  let info;
  try {
    info = await stat(path);
  } catch {
    return emptySnapshot();
  }
  if (!info.isFile()) return emptySnapshot();
  const cached = snapshotCache.get(path);
  if (cached?.mtimeMs === info.mtimeMs && cached.sizeBytes === info.size) return cached;
  const read = await readBoundedFile(path, STATUS_FILE_MAX_BYTES);
  const snapshot: RunSnapshot = {
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
    status: read === undefined ? undefined : parseJsonRecord(read.text),
    oversized: read?.oversized ?? false,
    lanes: undefined,
  };
  rememberSnapshot(path, snapshot);
  return snapshot;
}

function emptySnapshot(): RunSnapshot {
  return { mtimeMs: 0, sizeBytes: 0, status: undefined, oversized: false, lanes: [] };
}

function rememberSnapshot(path: string, snapshot: RunSnapshot): void {
  // Re-insert so the map's insertion order stays a least-recently-written order.
  snapshotCache.delete(path);
  snapshotCache.set(path, snapshot);
  if (snapshotCache.size <= SNAPSHOT_CACHE_MAX_ENTRIES) return;
  const oldest = snapshotCache.keys().next();
  if (oldest.done === true) return;
  snapshotCache.delete(oldest.value);
}

async function loadLanes(snapshot: RunSnapshot): Promise<readonly LaneSnapshot[]> {
  if (snapshot.lanes !== undefined) return snapshot.lanes;
  const runState = normalizeState(optionalString(snapshot.status, "state")) ?? "running";
  const stepsValue: unknown = getProperty(snapshot.status, "steps");
  const steps = Array.isArray(stepsValue) ? stepsValue : [];
  const lanes = await mapWithLimit(steps, LANE_READ_CONCURRENCY, (step, index) => readLane(step, index, runState));
  snapshot.lanes = lanes;
  return lanes;
}

/** Runs `map` over `items` with at most `limit` reads in flight, keeping the input order. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const queue = [...items.entries()];
  const results: R[] = [];
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const [index, item] = entry;
      results[index] = await map(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker));
  return results;
}

function progressFromSnapshot(runId: string, snapshot: RunSnapshot, lanes: readonly LaneSnapshot[], now: number): SubagentRunProgress {
  const status = snapshot.status;
  const state = normalizeState(optionalString(status, "state")) ?? "running";
  const startedAt = optionalNumber(status, "startedAt");
  const endedAt = optionalNumber(status, "endedAt");
  const lastUpdate = optionalNumber(status, "lastUpdate");
  const totalMs = elapsedMs(startedAt, endedAt ?? (isTerminalState(state) ? undefined : now));
  const children = lanes.map((lane) => {
    const elapsed = laneElapsedMs(lane, now);
    return elapsed === undefined ? { ...lane.child } : { ...lane.child, elapsedMs: elapsed };
  });

  return {
    runId,
    state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(lastUpdate === undefined ? {} : { updatedAt: lastUpdate }),
    ...(totalMs === undefined ? {} : { totalMs }),
    children,
    ...(snapshot.oversized ? { statusOversized: true } : {}),
  };
}

/**
 * GET /api/subagent-runs/:runId/progress — 404 means this host has no run with that
 * id, which the chat card treats as "the run directory is not written yet".
 */
export function registerSubagentProgressRoutes(app: FastifyInstance, prefix = "/api", options: SubagentProgressOptions = {}): void {
  app.get<{ Params: { runId: string } }>(`${prefix}/subagent-runs/:runId/progress`, async (request, reply) => {
    const progress = await readSubagentProgress(request.params.runId, options);
    if (progress === undefined) return reply.code(404).send({ error: "Subagent run not found" });
    return progress;
  });

  // The composer dock asks for one session at a time; an unknown session is simply empty.
  app.get<{ Querystring: { sessionId?: string; machineId?: string } }>(`${prefix}/subagent-runs`, async (request, reply) => {
    const machineId = request.query.machineId ?? LOCAL_MACHINE_ID;
    // Run state lives in the temp directory of the host that ran the dispatch, so only
    // the local machine can answer. Saying so out loud beats an empty list, which the
    // dock would show as "nothing is running" for a session it cannot see.
    if (machineId !== LOCAL_MACHINE_ID) return { supported: false, machineId } satisfies SessionSubagentRunsResponse;
    const sessionId = request.query.sessionId;
    if (sessionId === undefined || !RUN_ID_PATTERN.test(sessionId)) return reply.code(400).send({ error: "sessionId must be a UUID" });
    const listing: SessionSubagentRunsResponse = { supported: true, runs: await listSessionSubagentRuns(sessionId, options) };
    return listing;
  });
}

async function readLane(step: unknown, index: number, runState: SubagentRunState): Promise<LaneSnapshot> {
  const status = normalizeState(optionalString(step, "status")) ?? runState;
  const startedAt = optionalNumber(step, "startedAt");
  // The session log path is host-written runtime state, never client input: the
  // client supplies only the run id, which findRunDir validates.
  const sessionFile = optionalString(step, "sessionFile");
  const sessionRead = sessionFile === undefined || sessionFile === "" ? undefined : await readBoundedFile(sessionFile, SESSION_TAIL_MAX_BYTES);
  const usage = sessionRead === undefined ? undefined : scanSessionTail(sessionRead.text, sessionRead.oversized);
  const child: Omit<SubagentProgressChild, "elapsedMs"> = {
    key: optionalString(step, "workflowKey") ?? optionalString(step, "runId") ?? `step-${String(index)}`,
    label: stepLabel(step, index),
    agent: optionalString(step, "agent") ?? "",
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    toolCount: usage?.toolCount ?? 0,
    ...(usage?.lastTool === undefined ? {} : { lastTool: usage.lastTool }),
    ...(usage?.lastText === undefined ? {} : { lastText: usage.lastText }),
    ...(usage?.isError === undefined ? {} : { isError: usage.isError }),
  };
  return {
    child,
    durationMs: optionalNumber(step, "durationMs"),
    endedAt: optionalNumber(step, "endedAt"),
    sessionMtimeMs: sessionRead?.mtimeMs,
  };
}

function laneElapsedMs(lane: LaneSnapshot, now: number): number | undefined {
  if (lane.durationMs !== undefined) return lane.durationMs;
  const startedAt = lane.child.startedAt;
  if (startedAt === undefined) return undefined;
  // A running lane has no end stamp yet; a finished lane whose status never
  // recorded one still has the last write to its session log.
  return elapsedMs(startedAt, isTerminalState(lane.child.status) ? lane.endedAt ?? lane.sessionMtimeMs : now);
}

function elapsedMs(startedAt: number | undefined, end: number | undefined): number | undefined {
  if (startedAt === undefined || end === undefined) return undefined;
  return Math.max(0, end - startedAt);
}

/**
 * Tool activity and the newest assistant line from the tail of one child session
 * log. The subagents runtime writes two log shapes to `sessionFile` depending on
 * the host: its own event transcript (`recordType` records) and the Pi session log
 * of the child (`type: "message"` records). Both are accepted so a lane shows
 * progress instead of an empty row.
 */
function scanSessionTail(text: string, truncatedHead: boolean): SessionTailUsage {
  const usage: SessionTailUsage = { toolCount: 0, lastTool: undefined, lastText: undefined, isError: undefined };
  const lines = text.split("\n");
  // A tail window almost always starts inside a record; that fragment is not JSON.
  const firstLine = truncatedHead ? 1 : 0;
  for (let index = firstLine; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const record = parseJsonRecord(line);
    if (record === undefined) continue;
    readSessionRecord(record, usage);
  }
  return usage;
}

function readSessionRecord(record: Record<string, unknown>, usage: SessionTailUsage): void {
  const recordType = optionalString(record, "recordType");
  if (recordType === "tool_start") {
    usage.toolCount += 1;
    usage.lastTool = optionalString(record, "toolName") ?? usage.lastTool;
    return;
  }
  if (recordType === "tool_end") {
    usage.lastTool = optionalString(record, "toolName") ?? usage.lastTool;
    const isError = optionalBoolean(record, "isError");
    if (isError !== undefined) usage.isError = isError;
    return;
  }

  const message = getRecord(record, "message") ?? record;
  const role = optionalString(message, "role") ?? optionalString(record, "role");
  const content = getProperty(message, "content");
  if (Array.isArray(content)) {
    for (const entry of content) {
      const type = optionalString(entry, "type");
      if (type === "toolCall") {
        usage.toolCount += 1;
        usage.lastTool = optionalString(entry, "name") ?? optionalString(entry, "toolName") ?? usage.lastTool;
      } else if (type === "text" && role === "assistant") {
        const text = optionalString(entry, "text");
        if (text !== undefined) usage.lastText = lastOutputLine(text) ?? usage.lastText;
      }
    }
  }
  if (role !== "assistant") return;
  const plainText = optionalString(record, "text");
  if (plainText !== undefined) usage.lastText = lastOutputLine(plainText) ?? usage.lastText;
}

/**
 * Newest line of one assistant message that actually says something, stripped of
 * markdown markers. Two things are skipped: lines of only punctuation (the tail of
 * a coding child is usually a closing brace or a lone bracket) and fenced code —
 * the last line of a report is often a JSON fragment, which reads as noise in a
 * one-line card. A message that is nothing but code still falls back to its tail.
 */
function lastOutputLine(text: string): string | undefined {
  const lines = text.split("\n");
  const fenced = fenceMask(lines);
  for (let pass = 0; pass < 2; pass++) {
    for (let index = lines.length - 1; index >= 0; index--) {
      if (pass === 0 && fenced[index] === true) continue;
      const line = markdownFreeText(lines[index] ?? "");
      if (line === "" || !/\p{L}|\p{N}/u.test(line)) continue;
      return truncate(line, LAST_TEXT_MAX_LENGTH);
    }
  }
  return undefined;
}

/** Marks every line that sits inside a fenced code block, markers included. */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let open = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      mask.push(true);
      open = !open;
      continue;
    }
    mask.push(open);
  }
  return mask;
}

function markdownFreeText(line: string): string {
  return line
    .replace(/^\s*(?:[#>]+|[-*+]|\d+[.)])\s*/, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - TRUNCATION_RESERVE)}…` : value;
}

function stepLabel(step: unknown, index: number): string {
  // `label` is the caller's human name for the lane and wins over the workflow key.
  // `sessionName` is the runtime's generated "worker: <task…>" title: it repeats the
  // task the tool card already shows, so the agent name is a better fallback.
  const label = optionalString(step, "label")
    ?? optionalString(step, "workflowKey")
    ?? optionalString(step, "agent")
    ?? optionalString(step, "sessionName");
  const normalized = label === undefined ? "" : label.replace(/\s+/g, " ").trim();
  return normalized === "" ? `step ${String(index + 1)}` : normalized;
}

/**
 * Run and step statuses share one vocabulary on the wire. The runtime writes
 * `complete` for a finished run, so map it onto the client-facing `completed`
 * rather than leaking two spellings of the same state.
 */
function normalizeState(value: string | undefined): SubagentRunState | undefined {
  return value === undefined ? undefined : RUN_STATE_BY_STATUS[value];
}

function isTerminalState(state: SubagentRunState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<BoundedRead | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    // Only the newest bytes matter: a session log grows without bound, and a status
    // file over the budget still describes its run from the tail rather than vanishing.
    const length = Math.min(info.size, maxBytes);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: buffer.toString("utf8", 0, offset), mtimeMs: info.mtimeMs, oversized: start > 0 };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const property = getProperty(value, key);
  return isRecord(property) ? property : undefined;
}

function optionalString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function optionalNumber(value: unknown, key: string): number | undefined {
  const property = getProperty(value, key);
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}
