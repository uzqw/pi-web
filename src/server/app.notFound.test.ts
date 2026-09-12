import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("SPA fallback boundaries", () => {
  let clientDist: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    clientDist = await mkdtemp(join(tmpdir(), "pi-web-client-dist-"));
    await writeFile(join(clientDist, "index.html"), "<!doctype html><html><body>spa</body></html>");
    app = await buildApp({ clientDist, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await rm(clientDist, { recursive: true, force: true });
  });

  it("returns a JSON 404 for unmatched API paths instead of the index document", async () => {
    const response = await app.inject({ method: "GET", url: "/api/definitely-not-a-registered-route" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("keeps serving the index document for unmatched browser navigation paths", async () => {
    const response = await app.inject({ method: "GET", url: "/sessions/some/unknown/client/route" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });
});
