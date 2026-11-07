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
export function createLarkRoutes({ controller, agentApiKey }) {
  const router = Router();
  const agentOnly = requireAgentKey(agentApiKey);

  router.post("/send", express.json({ limit: "100kb" }), agentOnly, controller.sendToCustomer);
  router.get("/customers", agentOnly, controller.listCustomers);

  return router;
}
