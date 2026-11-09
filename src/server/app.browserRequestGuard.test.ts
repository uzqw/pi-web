import { describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

// The harness writes no allowedHosts, which means the restricted default: only
// loopback names and IP literals are admitted.
describe("buildApp browser request guard wiring", () => {
  it("guards assets, APIs and unknown routes before they run", async () => {
    for (const url of ["/api/pi-web/health", "/api/pi-packages", "/api/sessions", "/unknown", "/pi-web-plugins/fake/plugin.js"]) {
      const response = await appTestContext.app.inject({ url, headers: { host: "evil.example" } });
      expect(response.statusCode, url).toBe(403);
    }
    expect(appTestContext.piPackageRequests).toEqual([]);
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });

  it("admits the hosts a local browser and the LAN reverse proxy use", async () => {
    for (const host of ["127.0.0.1:18504", "localhost:8505", "10.0.0.4:8504"]) {
      const response = await appTestContext.app.inject({ url: "/api/pi-web/health", headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it("blocks a cross-origin package update without touching the service", async () => {
    const blocked = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pi-packages/update",
      headers: { origin: "https://evil.example" },
      payload: {},
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
    expect(appTestContext.piPackageRequests).toEqual([]);

    const accepted = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pi-packages/update",
      headers: { host: "localhost:8505", origin: "http://localhost:8505" },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(appTestContext.piPackageRequests).toEqual([{ action: "update" }]);
  });

  it("blocks cross-origin session, machine and plugin requests before upstream work", async () => {
    for (const url of ["/api/sessions", "/api/machines/local/sessions", "/api/machines/remote/sessions", "/api/plugin-sessions/terminal"]) {
      const response = await appTestContext.app.inject({ method: "POST", url, headers: { origin: "https://evil.example" }, payload: {} });
      expect(response.statusCode, url).toBe(403);
    }
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });

  it("keeps the startup policy after the config saves a wider one", async () => {
    const saved = await appTestContext.app.inject({ method: "PUT", url: "/api/config", payload: { config: { allowedHosts: true } } });
    expect(saved.statusCode).toBe(200);
    const response = await appTestContext.app.inject({ url: "/api/pi-web/health", headers: { host: "evil.example" } });
    expect(response.statusCode).toBe(403);
  });

  it("leaves a cross-origin JSON preflight without CORS permission", async () => {
    const response = await appTestContext.app.inject({
      method: "OPTIONS",
      url: "/api/pi-packages/update",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(response.statusCode).not.toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
