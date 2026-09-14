import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const LISTING_CWD = "/srv/dev/pi-web";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-listing-freshness-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PiSessionService listing of replaced session files", () => {
  it("lists and opens the session that replaced a listed path instead of serving the stale one", async () => {
    // The summary scanner memoizes listings per path but notices identity
    // replacements. If a warm listing kept serving the old entry for a
    // replaced path, the replacement would appear in the listing but stay
    // permanently unopenable ("Session not found").
    const sessionDir = join(tempDir, "replace-sessions");
    await mkdir(sessionDir, { recursive: true });
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    const header = (id: string, sessionCwd: string) =>
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd });
    const originalPath = join(sessionDir, "2026-01-01T00-00-00-000Z_original-id.jsonl");
    await writeFile(originalPath, `${header("original-id", LISTING_CWD)}\n${message("m1", "user", "original transcript")}\n`, "utf8");

    const realGateway = createPiSessionManagerGateway({
      agentDir: TEST_AGENT_DIR,
      env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
    });
    const replacementRuntime = fakeRuntime("replacement-id", {
      sessionManager: fakeSessionManager(LISTING_CWD, {
        getSessionId: () => "replacement-id",
        getBranch: () => [{ type: "message", id: "r1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "replacement transcript" } }],
      }),
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(replacementRuntime.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (refCwd: string) => realGateway.list(refCwd),
        listAll: () => realGateway.listAll(),
        resolveSessionFile: (refCwd: string, sessionId: string) => realGateway.resolveSessionFile(refCwd, sessionId),
        invalidateSessionFile: (sessionFile: string) => {
          realGateway.invalidateSessionFile(sessionFile);
        },
        open: () => fakeSessionManager(LISTING_CWD, { getSessionId: () => "replacement-id" }),
      },
      heartbeatIntervalMs: 60_000,
    });

    const cold = await service.list(LISTING_CWD);
    expect(cold.map((session) => session.id)).toEqual(["original-id"]);

    // Atomic replacement: a new file is renamed over the cached path.
    const replacementFile = join(sessionDir, "2026-01-02T00-00-00-000Z_replacement-id.jsonl");
    await writeFile(replacementFile, `${header("replacement-id", LISTING_CWD)}\n${message("r1", "user", "replacement transcript")}\n`, "utf8");
    await rename(replacementFile, originalPath);

    const warm = await service.list(LISTING_CWD);
    expect(warm.map((session) => session.id)).toEqual(["replacement-id"]);

    // The open path must agree with the listing...
    const page = await service.messages(sessionRef("replacement-id", LISTING_CWD));
    expect(page.messages).toEqual([{ role: "user", content: "replacement transcript" }]);
    // ...and the replaced session is really gone.
    await expect(service.messages(sessionRef("original-id", LISTING_CWD))).rejects.toThrow("Session not found");
    await service.dispose();
  });
});

describe("PiSessionService.detachParent summary memo", () => {
  it("invalidates the gateway summary memo so warm listings re-read the rewritten header", async () => {
    // The gateway keeps one memoized scanner for its lifetime. Detach rewrites
    // the header in place, keeping the inode, so the memo's identity + size
    // key cannot see the change whenever the rewritten file happens to be the
    // size the memo recorded (a concurrent append can make the shrunk header
    // net out). Detach must therefore invalidate the entry explicitly, and
    // the warm listing must show the cleared parent. This test lists through
    // the real gateway/scanner path on purpose: fakes cannot see the memo.
    const invalidated: string[] = [];
    const sessionDir = join(tempDir, "detach-sessions");
    await mkdir(sessionDir, { recursive: true });
    const parentPath = join(sessionDir, "parent.jsonl");
    await writeFile(parentPath, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: LISTING_CWD })}\n`, "utf8");
    const childPath = join(sessionDir, "child.jsonl");
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    await writeFile(childPath, [
      JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: LISTING_CWD, parentSession: parentPath }),
      message("m1", "user", "hello"),
      message("m2", "assistant", "hi there"),
    ].join("\n") + "\n", "utf8");

    const realGateway = createPiSessionManagerGateway({
      agentDir: TEST_AGENT_DIR,
      env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
    });
    const child = fakeRuntime("child", { sessionFile: childPath });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(child.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (refCwd: string) => realGateway.list(refCwd),
        listAll: () => realGateway.listAll(),
        resolveSessionFile: (refCwd: string, sessionId: string) => realGateway.resolveSessionFile(refCwd, sessionId),
        invalidateSessionFile: (sessionFile: string) => {
          invalidated.push(sessionFile);
          realGateway.invalidateSessionFile(sessionFile);
        },
        open: () => fakeSessionManager(LISTING_CWD, { getSessionId: () => "child" }),
      },
      heartbeatIntervalMs: 60_000,
    });

    const before = await service.list(LISTING_CWD);
    expect(before.find((session) => session.id === "child")).toMatchObject({ id: "child", messageCount: 2, parentSessionPath: parentPath });

    await service.detachParent(sessionRef("child", LISTING_CWD));

    // The rewritten file's own path is dropped from the memo — the only
    // signal an identity + size key cannot derive for itself.
    expect(invalidated).toContain(childPath);

    const after = await service.list(LISTING_CWD);
    const detached = after.find((session) => session.id === "child");
    expect(detached).toMatchObject({ id: "child", messageCount: 2 });
    expect(detached).not.toHaveProperty("parentSessionPath");
    await service.dispose();
  });
});

describe("PiSessionService listing of live session names", () => {
  it("keeps a name that only exists in memory before the first assistant message", async () => {
    // The SDK writes nothing to a transcript until the first assistant message,
    // so a renamed brand-new session has no file, no listing entry, and only an
    // in-memory name. Serving the side bar from the disk scan alone reverts the
    // row to its session id until that first message flushes the file.
    const fake = fakeRuntime("unflushed-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    fake.session.sessionName = "【#1-30 写周报】";

    const listed = await service.list("/workspace");
    expect(listed.find((session) => session.id === "unflushed-session")).toMatchObject({
      id: "unflushed-session",
      name: "【#1-30 写周报】",
      persisted: false,
    });
    await service.dispose();
  });

  it("prefers the in-memory name over the one scanned from an older transcript", async () => {
    const fake = fakeRuntime("rename-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: sessionGateway([sessionRecord("rename-session", "/workspace", { name: "Old name" })]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    fake.session.sessionName = "New name";

    const listed = await service.list("/workspace");
    expect(listed.find((session) => session.id === "rename-session")).toMatchObject({
      id: "rename-session",
      name: "New name",
      persisted: true,
    });
    await service.dispose();
  });
});
