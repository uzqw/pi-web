import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizedGitEnv } from "./gitEnv.js";

const execFileAsync = promisify(execFile);

/** Current branch of the git checkout at `path`; null when unavailable or detached. */
export async function gitBranch(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
      env: sanitizedGitEnv(),
      maxBuffer: 4096,
    });
    const branch = stdout.trim();
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}
