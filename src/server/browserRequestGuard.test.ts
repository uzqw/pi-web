import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { registerBrowserRequestGuard } from "./browserRequestGuard.js";
import type { HostAccessPolicy } from "../shared/hostAccess.js";

let app: FastifyInstance | undefined;
let hits: string[] = [];

async function guardApp(policy: HostAccessPolicy | undefined): Promise<FastifyInstance> {
  hits = [];
  const instance = Fastify({ logger: false });
  await instance.register(fastifyWebsocket);
  registerBrowserRequestGuard(instance, policy);
  instance.all("/api/probe", (request) => {
    hits.push(request.url);
    return { ok: true };
  });
  instance.get("/api/events", { websocket: true }, (socket) => {
    socket.close();
  });
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("browser request guard", () => {
  it("allows the loopback and IP hosts a local or proxied browser uses", async () => {
    const instance = await guardApp([]);
    for (const host of ["127.0.0.1:18504", "localhost:8505", "10.0.0.4:8504", "[::1]:8505"]) {
      const response = await instance.inject({ url: "/api/probe", headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it("refuses a foreign host before the handler runs", async () => {
    const instance = await guardApp([]);
    const response = await instance.inject({ url: "/api/probe", headers: { host: "evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toContain("Host not allowed");
    expect(hits).toEqual([]);
  });

  it("admits a configured public name, including through a reverse proxy port", async () => {
    const instance = await guardApp(["pi.example.com"]);
    const response = await instance.inject({ url: "/api/probe", headers: { host: "pi.example.com:443" } });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a duplicated host header instead of picking one", async () => {
    const instance = await guardApp([]);
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const { port } = new URL(address);
    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1");
      let response = "";
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("utf8");
      });
      socket.once("close", () => {
        resolve(response.split("\r\n", 1)[0] ?? "");
      });
      socket.write("GET /api/probe HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
    expect(status).toContain("403");
    expect(hits).toEqual([]);
  });

  it("rejects authority forms that URL parsing would repair", async () => {
    const instance = await guardApp(["pi.example.com"]);
    for (const host of ["user@pi.example.com", "pi.example.com:", " pi.example.com", "pi.example.com/path", "pi.example.com:0"]) {
      const response = await instance.inject({ url: "/api/probe", headers: { host } });
      expect(response.statusCode, host).toBe(403);
    }
  });

  it("blocks a mutating cross-origin request before it reaches the handler", async () => {
    const instance = await guardApp([]);
    const blocked = await instance.inject({
      method: "POST",
      url: "/api/probe",
      headers: { host: "10.0.0.4:8504", origin: "https://evil.example" },
      payload: {},
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: string }>().error).toContain("Origin not allowed");
    expect(hits).toEqual([]);

    const accepted = await instance.inject({
      method: "POST",
      url: "/api/probe",
      headers: { host: "10.0.0.4:8504", origin: "https://10.0.0.4:8504" },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("accepts a same-origin request over a different scheme, because TLS ends at the proxy", async () => {
    const instance = await guardApp([]);
    const response = await instance.inject({
      method: "POST",
      url: "/api/probe",
      headers: { host: "10.0.0.4:8504", origin: "http://10.0.0.4:8504" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it("lets a request without an origin through, since only browsers send one", async () => {
    const instance = await guardApp([]);
    const response = await instance.inject({ method: "POST", url: "/api/probe", headers: { host: "127.0.0.1:18504" }, payload: {} });
    expect(response.statusCode).toBe(200);
  });

  it("does not inspect the origin of a safe read", async () => {
    const instance = await guardApp([]);
    const response = await instance.inject({ url: "/api/probe", headers: { host: "127.0.0.1:18504", origin: "https://evil.example" } });
    expect(response.statusCode).toBe(200);
  });

  it("rejects an upgrade from a foreign origin and leaves no client connected", async () => {
    const instance = await guardApp([]);
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${address.replace("http:", "ws:")}/api/events`, { origin: "https://evil.example", handshakeTimeout: 2_000 });
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => {
        socket.close();
        resolve(101);
      });
    });
    expect(status).toBe(403);
    expect(instance.websocketServer.clients.size).toBe(0);
  });

  it("keeps the policy it was registered with, even if the caller mutates it", async () => {
    const policy = ["pi.example.com"];
    const instance = await guardApp(policy);
    expect((await instance.inject({ url: "/api/probe", headers: { host: "pi.example.com" } })).statusCode).toBe(200);
    policy.push("evil.example");
    const stillBlocked = await instance.inject({ url: "/api/probe", headers: { host: "evil.example" } });
    expect(stillBlocked.statusCode).toBe(403);
  });

  it("rejects an absolute-form request target, whose authority Host cannot cover", async () => {
    const instance = await guardApp([]);
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const { port } = new URL(address);
    // inject() rewrites the target to origin-form, so the only way to prove this
    // is a raw request line: a checked Host would otherwise cover an unchecked host.
    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1");
      let response = "";
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("utf8");
      });
      socket.once("close", () => {
        resolve(response.split("\r\n", 1)[0] ?? "");
      });
      socket.write("GET http://evil.example/api/probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
    expect(status).toContain("403");
    expect(hits).toEqual([]);
  });
});
