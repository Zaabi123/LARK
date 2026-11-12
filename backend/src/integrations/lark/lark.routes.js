import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual ?? ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only your own agent/scripts (holding AGENT_API_KEY) may send or list customers. */
function requireAgentKey(agentApiKey) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(token, agentApiKey)) {
      return res.status(401).json({ error: "Missing or invalid AGENT_API_KEY bearer token." });
    }
    next();
  };
}

// Incoming messages arrive over Lark's long connection (an outbound WebSocket), so there is no webhook route.
export function createLarkRoutes({ controller, agentApiKey, reminders }) {
  const router = Router();
  const agentOnly = requireAgentKey(agentApiKey);

  router.post("/send", express.json({ limit: "100kb" }), agentOnly, controller.sendToCustomer);
  router.get("/customers", agentOnly, controller.listCustomers);

  // Scheduled reminders (need REDIS_URL). POST { to, text, at, repeat?: "none" | "daily" | "weekly" }
  const needRedis = (req, res, next) =>
    reminders ? next() : res.status(503).json({ error: "Reminders need Redis: set REDIS_URL on the backend." });
  router.get("/reminders", agentOnly, needRedis, async (req, res) => res.json(await reminders.list()));
  router.post("/reminders", express.json({ limit: "100kb" }), agentOnly, needRedis, async (req, res) => {
    try {
      res.status(201).json(await reminders.schedule(req.body));
    } catch (error) {
      if (error.name === "ReminderInputError") return res.status(400).json({ error: error.message });
      throw error;
    }
  });
  router.delete("/reminders/:id", agentOnly, needRedis, async (req, res) =>
    (await reminders.cancel(req.params.id))
      ? res.json({ cancelled: true, id: req.params.id })
      : res.status(404).json({ error: "No upcoming reminder with that id (it may have been sent already)." }),
  );

  return router;
}
