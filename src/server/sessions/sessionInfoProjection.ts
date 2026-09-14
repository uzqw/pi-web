import type { ClientSession } from "../types.js";

/**
 * The subset of a live Pi session needed to project it as a browser session record.
 *
 * Structural on purpose: the command service and the session service hold the real
 * `PiAgentSession`, and both need the same projection without importing each other.
 */
export interface ProjectableSession {
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  readonly messages: readonly unknown[];
  sessionManager: {
    getHeader?(): { parentSession?: string } | null | undefined;
  };
}

/**
 * Project a live runtime session into the browser-facing session record.
 *
 * `parentSessionPath` comes from the session file header, which is where PI WEB records
 * the session this one replaced (extension `newSession`, fork, clone).
 */
export function projectSessionInfo(cwd: string, session: ProjectableSession): ClientSession {
  const parentSessionPath =
    typeof session.sessionManager.getHeader === "function" ? session.sessionManager.getHeader()?.parentSession : undefined;
  const now = new Date().toISOString();
  return {
    id: session.sessionId,
    path: session.sessionFile ?? "",
    cwd,
    ...(session.sessionName === undefined ? {} : { name: session.sessionName }),
    created: now,
    modified: now,
    messageCount: session.messages.length,
    firstMessage: "",
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
  };
}
