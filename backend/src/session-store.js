// Conversation history per customer. In Redis when REDIS_URL is set (survives restarts and redeploys),
// otherwise in memory. Entries expire after 24 h without activity, like before.
import { reportError } from "./instrument.js";

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
const redisKey = (key) => `lark:session:${key}`;

export function createSessionStore(redis) {
  const memory = new Map();

  function failed(action, key, error) {
    console.error(`[cache] ${action} failed for ${key}: ${error.message}`);
    reportError(error, { component: "session-cache", action, customer: key });
  }

  return {
    backend: redis ? "redis" : "memory",

    /** Returns the saved session, or null when there is none (or it expired). */
    async get(key) {
      if (!redis) {
        const s = memory.get(key);
        return s && Date.now() - s.updatedAt < SESSION_TTL_SECONDS * 1000 ? s : null;
      }
      try {
        const raw = await redis.get(redisKey(key));
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        failed("read", key, error); // carry on with a fresh conversation rather than not replying
        return null;
      }
    },

    async set(key, session) {
      if (!redis) return void memory.set(key, session);
      try {
        await redis.set(redisKey(key), JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
      } catch (error) {
        failed("write", key, error);
      }
    },

    async delete(key) {
      if (!redis) return void memory.delete(key);
      try {
        await redis.del(redisKey(key));
      } catch (error) {
        failed("delete", key, error);
      }
    },
  };
}
