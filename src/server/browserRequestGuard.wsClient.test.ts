import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { registerBrowserRequestGuard } from "./browserRequestGuard.js";

/**
 * The web/API process reaches the session daemon over a unix socket, and the daemon
 * now guards its own listeners. That only works while the client library sends a
 * header the guard admits, which is an assumption about `ws` and `node:http` rather
 * than about our code: pin it here, so a client upgrade cannot silently break every
 * live session stream at deploy time.
 */

let app: FastifyInstance | undefined;
let socketDir: string | undefined;

async function daemonLikeApp(policy: readonly string[] | true | undefined): Promise<{ app: FastifyInstance; socketPath: string }> {
  socketDir = await mkdtemp(join(tmpdir(), "pi-web-guard-ws-"));
  const socketPath = join(socketDir, "sessiond.sock");
  const instance = Fastify({ logger: false });
  await instance.register(fastifyWebsocket);
  registerBrowserRequestGuard(instance, policy);
  instance.get("/events", { websocket: true }, (socket) => {
    socket.close();
  });
  await instance.listen({ path: socketPath });
  app = instance;
  return { app: instance, socketPath };
}

function handshakeStatus(url: string, options: { origin?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { ...options, handshakeTimeout: 2_000 });
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
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (socketDir !== undefined) await rm(socketDir, { recursive: true, force: true });
  socketDir = undefined;
});

describe("session daemon admission for its own clients", () => {
  it("admits the unix-socket client the web/API process actually sends", async () => {
    const { socketPath } = await daemonLikeApp([]);
    // No Origin: only browsers send one, and this client is not a browser.
    await expect(handshakeStatus(`ws+unix:${socketPath}:/events`)).resolves.toBe(101);
  });

  it("still refuses a cross-origin page that reaches the same listener", async () => {
    const { socketPath } = await daemonLikeApp([]);
    await expect(handshakeStatus(`ws+unix:${socketPath}:/events`, { origin: "https://evil.example" })).resolves.toBe(403);
  });
});
