/**
 * Browser-shared user preferences (pins and model presets) that the session
 * daemon owns and persists, so every browser on a machine sees the same state.
 *
 * The daemon stores an opaque key -> JSON value map; the keys below are the
 * only ones the core client uses, and the daemon never interprets them.
 */

export const PINNED_PROJECTS_PREFERENCE_KEY = "pinned-projects";
export const PINNED_WORKSPACES_PREFERENCE_KEY = "pinned-workspaces";
export const PINNED_SESSIONS_PREFERENCE_KEY = "pinned-sessions";
export const MODEL_PRESETS_PREFERENCE_KEY = "model-presets";

/** Upper bound on a preference key; the daemon rejects longer ones. */
export const MAX_PREFERENCE_KEY_LENGTH = 128;

/** The daemon's full preference map, as returned by `GET /preferences`. */
export type PreferencesSnapshot = Record<string, unknown>;

/** A single preference change, broadcast to every connected browser. */
export interface PreferencesUpdatedEvent {
  type: "preferences.updated";
  key: string;
  value: unknown;
}
