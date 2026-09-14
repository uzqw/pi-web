import type { FastifyInstance } from "fastify";
import type { PreferencesStore } from "../storage/preferencesStore.js";
import { isValidPreferenceKey } from "../storage/preferencesStore.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { PreferencesUpdatedEvent } from "../../shared/preferences.js";

export interface PreferencesRouteDependencies {
  store: PreferencesStore;
  events: Pick<SessionEventHub, "publishRealtime">;
}

/**
 * Browser-shared preference routes. The daemon owns the map; a write is
 * persisted and then broadcast on the global realtime channel so every
 * connected browser converges without polling.
 */
export function registerPreferencesRoutes(
  app: FastifyInstance,
  dependencies: PreferencesRouteDependencies,
  prefix = "/preferences",
): void {
  app.get(prefix, async (_request, reply) => {
    try {
      return { preferences: await dependencies.store.snapshot() };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown } | undefined }>(`${prefix}/:key`, async (request, reply) => {
    const key = request.params.key;
    if (!isValidPreferenceKey(key)) return reply.code(400).send({ error: "Invalid preference key" });
    if (request.body === undefined || !("value" in request.body)) {
      return reply.code(400).send({ error: "Preference update must include a value" });
    }
    try {
      await dependencies.store.set(key, request.body.value);
      const event: PreferencesUpdatedEvent = { type: "preferences.updated", key, value: request.body.value };
      dependencies.events.publishRealtime(event);
      return { preferences: await dependencies.store.snapshot() };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
