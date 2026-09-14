import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { piWebDataDir } from "../../config.js";
import { MAX_PREFERENCE_KEY_LENGTH, type PreferencesSnapshot } from "../../shared/preferences.js";

/**
 * Data-directory-backed map of browser-shared user preferences (pinned
 * projects/workspaces/sessions, model presets). This is state, not
 * user-editable configuration, so it lives under `$PI_WEB_DATA_DIR` alongside
 * `projects.json`/`machines.json` rather than in `$PI_WEB_CONFIG`.
 *
 * Values are opaque JSON: the daemon never interprets a key or a value, so the
 * client owns the shape of each preference.
 */

interface PreferencesFile {
  preferences: PreferencesSnapshot;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreferencesFile(value: unknown): PreferencesFile {
  if (!isRecord(value) || !isRecord(value["preferences"])) throw new Error("Invalid preferences file");
  return { preferences: value["preferences"] };
}

export function defaultPreferencesStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "preferences.json");
}

export function preferencesStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_PREFERENCES_FILE"];
  if (configured === undefined || configured === "") return defaultPreferencesStorePath(env, cwd);
  return resolve(cwd, configured);
}

export function isValidPreferenceKey(key: string): boolean {
  return key !== "" && key.length <= MAX_PREFERENCE_KEY_LENGTH;
}

export class PreferencesStore {
  /**
   * In-memory authority. Disk is read once on first access and written through
   * on every change; a read-modify-write per write is unnecessary because this
   * map is the only writer.
   */
  private preferences: PreferencesSnapshot | undefined;

  constructor(private readonly filePath = preferencesStorePath()) {}

  async snapshot(): Promise<PreferencesSnapshot> {
    return { ...(await this.load()) };
  }

  async set(key: string, value: unknown): Promise<void> {
    const preferences = await this.load();
    preferences[key] = value;
    await this.write(preferences);
  }

  private async load(): Promise<PreferencesSnapshot> {
    if (this.preferences !== undefined) return this.preferences;
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      this.preferences = parsePreferencesFile(value).preferences;
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      this.preferences = {};
    }
    return this.preferences;
  }

  private async write(preferences: PreferencesSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify({ preferences }, null, 2)}\n`, "utf8");
  }
}
