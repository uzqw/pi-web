import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SubagentProgressChild, SubagentRunProgress, SubagentRunState } from "../shared/apiTypes.js";

const RUN_GROUP_PREFIX = "pi-subagents-";
const RUNS_DIRECTORY = "async-subagent-runs";
const STATUS_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_TAIL_MAX_BYTES = 256 * 1024;
const LAST_TEXT_MAX_LENGTH = 160;
const TRUNCATION_RESERVE = 3;
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
  /** True when the window dropped the beginning of the file. */
  truncatedHead: boolean;
}

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

  const statusRead = await readBoundedFile(join(runDir, "status.json"), STATUS_FILE_MAX_BYTES, "head");
  const status = statusRead === undefined ? undefined : parseJsonRecord(statusRead.text);
  return progressFromStatus(runId, status, options);
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
  const matches: { runId: string; status: Record<string, unknown> | undefined }[] = [];
  for (const runDir of await listRunDirs(runsRoot)) {
    const statusRead = await readBoundedFile(join(runDir, "status.json"), STATUS_FILE_MAX_BYTES, "head");
    const status = statusRead === undefined ? undefined : parseJsonRecord(statusRead.text);
    const parentSession = optionalString(status, "sessionId");
    if (parentSession?.includes(sessionId) !== true) continue;
    const runId = optionalString(status, "runId") ?? basename(runDir);
    matches.push({ runId, status });
  }
  matches.sort((left, right) => (optionalNumber(right.status, "startedAt") ?? 0) - (optionalNumber(left.status, "startedAt") ?? 0));
  const bounded = matches.slice(0, MAX_SESSION_RUNS);
  const runs = await Promise.all(
    bounded.map(async ({ runId, status }) => ({
      ...(await progressFromStatus(runId, status, options)),
      mode: optionalString(status, "mode") ?? "single",
    })),
  );
  return runs;
}

async function progressFromStatus(
  runId: string,
  status: Record<string, unknown> | undefined,
  options: SubagentProgressOptions,
): Promise<SubagentRunProgress> {
  const now = (options.now ?? Date.now)();
  const state = normalizeState(optionalString(status, "state")) ?? "running";
  const startedAt = optionalNumber(status, "startedAt");
  const endedAt = optionalNumber(status, "endedAt");
  const lastUpdate = optionalNumber(status, "lastUpdate");
  const stepsValue: unknown = getProperty(status, "steps");
  const steps = Array.isArray(stepsValue) ? stepsValue : [];
  const children = await Promise.all(steps.map((step, index) => readChild(step, index, state, now)));
  const totalMs = elapsedMs(startedAt, endedAt ?? (isTerminalState(state) ? undefined : now));

  return {
    runId,
    state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(lastUpdate === undefined ? {} : { updatedAt: lastUpdate }),
    ...(totalMs === undefined ? {} : { totalMs }),
    children,
  };
}

/**
 * GET /api/subagent-runs/:runId/progress — 404 means this host has no run with that
 * id, which the chat card treats as "nothing to show".
 */
export function registerSubagentProgressRoutes(app: FastifyInstance, prefix = "/api", options: SubagentProgressOptions = {}): void {
  app.get<{ Params: { runId: string } }>(`${prefix}/subagent-runs/:runId/progress`, async (request, reply) => {
    const progress = await readSubagentProgress(request.params.runId, options);
    if (progress === undefined) return reply.code(404).send({ error: "Subagent run not found" });
    return progress;
  });

  // The composer dock asks for one session at a time; an unknown session is simply empty.
  app.get<{ Querystring: { sessionId?: string } }>(`${prefix}/subagent-runs`, async (request, reply) => {
    const sessionId = request.query.sessionId;
    if (sessionId === undefined || !RUN_ID_PATTERN.test(sessionId)) return reply.code(400).send({ error: "sessionId must be a UUID" });
    return { runs: await listSessionSubagentRuns(sessionId, options) };
  });
}

async function readChild(step: unknown, index: number, runState: SubagentRunState, now: number): Promise<SubagentProgressChild> {
  const status = normalizeState(optionalString(step, "status")) ?? runState;
  const startedAt = optionalNumber(step, "startedAt");
  // The session log path is host-written runtime state, never client input: the
  // client supplies only the run id, which findRunDir validates.
  const sessionFile = optionalString(step, "sessionFile");
  const sessionRead = sessionFile === undefined || sessionFile === "" ? undefined : await readBoundedFile(sessionFile, SESSION_TAIL_MAX_BYTES, "tail");
  const usage = sessionRead === undefined ? undefined : scanSessionTail(sessionRead.text, sessionRead.truncatedHead);
  const elapsed = childElapsedMs(step, status, startedAt, now, sessionRead?.mtimeMs);

  return {
    key: optionalString(step, "workflowKey") ?? optionalString(step, "runId") ?? `step-${String(index)}`,
    label: stepLabel(step, index),
    agent: optionalString(step, "agent") ?? "",
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
    toolCount: usage?.toolCount ?? 0,
    ...(usage?.lastTool === undefined ? {} : { lastTool: usage.lastTool }),
    ...(usage?.lastText === undefined ? {} : { lastText: usage.lastText }),
    ...(usage?.isError === undefined ? {} : { isError: usage.isError }),
  };
}

function childElapsedMs(
  step: unknown,
  status: SubagentRunState,
  startedAt: number | undefined,
  now: number,
  sessionMtimeMs: number | undefined,
): number | undefined {
  const durationMs = optionalNumber(step, "durationMs");
  if (durationMs !== undefined) return durationMs;
  if (startedAt === undefined) return undefined;
  // A running lane has no end stamp yet; a finished lane whose status never
  // recorded one still has the last write to its session log.
  return elapsedMs(startedAt, isTerminalState(status) ? optionalNumber(step, "endedAt") ?? sessionMtimeMs : now);
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

async function readBoundedFile(path: string, maxBytes: number, mode: "head" | "tail"): Promise<BoundedRead | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    // A status file is one small object; a tail window is how session logs are read.
    if (mode === "head" && info.size > maxBytes) return undefined;
    const length = Math.min(info.size, maxBytes);
    const start = mode === "tail" ? info.size - length : 0;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: buffer.toString("utf8", 0, offset), mtimeMs: info.mtimeMs, truncatedHead: start > 0 };
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
