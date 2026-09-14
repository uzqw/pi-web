import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidPreferenceKey, PreferencesStore } from "./preferencesStore";
import { registerPreferencesRoutes } from "../sessiond/preferencesRoutes";
import { MAX_PREFERENCE_KEY_LENGTH, type PreferencesUpdatedEvent } from "../../shared/preferences";

let directory: string;
let app: FastifyInstance;
let store: PreferencesStore;
let published: PreferencesUpdatedEvent[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-web-preferences-"));
  store = new PreferencesStore(join(directory, "preferences.json"));
  published = [];
  const events = { publishRealtime: (event: PreferencesUpdatedEvent) => { published.push(event); } };
  app = Fastify({ logger: false });
  registerPreferencesRoutes(app, { store, events });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe("preferences routes", () => {
  it("starts empty and returns the written value", async () => {
    const empty = await app.inject({ method: "GET", url: "/preferences" });
    expect(empty.json()).toEqual({ preferences: {} });

    const write = await app.inject({ method: "PUT", url: "/preferences/pinned-sessions", payload: { value: ["a", "b"] } });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toEqual({ preferences: { "pinned-sessions": ["a", "b"] } });
  });

  it("broadcasts each write on the global channel and persists it", async () => {
    await app.inject({ method: "PUT", url: "/preferences/pinned-projects", payload: { value: ["p"] } });

    expect(published).toEqual([{ type: "preferences.updated", key: "pinned-projects", value: ["p"] }]);
    const onDisk: unknown = JSON.parse(await readFile(join(directory, "preferences.json"), "utf8"));
    expect(onDisk).toEqual({ preferences: { "pinned-projects": ["p"] } });
  });

  it("rejects a missing value", async () => {
    const missingValue = await app.inject({ method: "PUT", url: "/preferences/pinned-sessions", payload: {} });

    expect(missingValue.statusCode).toBe(400);
    expect(published).toEqual([]);
  });

  it("accepts a key at the length limit and rejects one past it", () => {
    expect(isValidPreferenceKey("k".repeat(MAX_PREFERENCE_KEY_LENGTH))).toBe(true);
    expect(isValidPreferenceKey("k".repeat(MAX_PREFERENCE_KEY_LENGTH + 1))).toBe(false);
    expect(isValidPreferenceKey("")).toBe(false);
  });
});

describe("PreferencesStore", () => {
  it("keeps keys independent and survives a fresh store instance", async () => {
    await store.set("a", 1);
    await store.set("b", "two");

    const reopened = new PreferencesStore(join(directory, "preferences.json"));
    expect(await reopened.snapshot()).toEqual({ a: 1, b: "two" });
  });
});
