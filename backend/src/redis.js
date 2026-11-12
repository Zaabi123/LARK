// Redis connection (Render Key Value, or any Redis/Valkey). Used for the conversation cache and the
// BullMQ reminder queue. Without REDIS_URL the app still runs: history stays in memory, reminders are off.
import { Redis } from "ioredis";
import { reportError } from "./instrument.js";

/**
 * Opens a connection with logging. `name` shows in the logs ("cache", "reminders-queue", ...).
 * BullMQ needs maxRetriesPerRequest: null; the cache uses a small number so a Redis outage
 * can't stall customer replies.
 */
export function createRedis(url, name, { maxRetriesPerRequest = 2 } = {}) {
  const redis = new Redis(url, {
    connectionName: `lark-${name}`,
    maxRetriesPerRequest,
    enableReadyCheck: true,
    // Render Key Value uses rediss:// (TLS) on its external URL; ioredis handles that from the URL.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  let lastError = 0;
  let wasReady = false;
  redis.on("ready", () => {
    console.log(`[redis] ${name} ${wasReady ? "reconnected" : "connected"}`);
    wasReady = true;
  });
  redis.on("error", (error) => {
    // ioredis emits an error on every reconnect attempt; log at most one per minute.
    if (Date.now() - lastError < 60_000) return;
    lastError = Date.now();
    console.error(`[redis] ${name} error: ${error.message}`);
    reportError(error, { component: `redis-${name}` });
  });
  return redis;
}
