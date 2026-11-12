import "dotenv/config";
// Better Stack. `npm start` already loads this first (node --import), so this import reuses that copy.
import { setupErrorMonitoring } from "./instrument.js";
import express from "express";
import * as Lark from "@larksuiteoapi/node-sdk";
import { pathToFileURL } from "node:url";
import { createLarkService } from "./integrations/lark/lark.service.js";
import { createLarkController } from "./integrations/lark/lark.controller.js";
import { createLarkRoutes } from "./integrations/lark/lark.routes.js";

// Lark (international, open.larksuite.com) and Feishu (China, open.feishu.cn) are separate platforms.
const DOMAINS = { lark: "https://open.larksuite.com", feishu: "https://open.feishu.cn" };
const domainName = (process.env.LARK_DOMAIN || "lark").toLowerCase();

const config = {
  // Render/Railway route traffic to 0.0.0.0; locally stay on 127.0.0.1.
  host: process.env.HOST || ((process.env.RENDER || process.env.RAILWAY_ENVIRONMENT) ? "0.0.0.0" : "127.0.0.1"),
  port: Number(process.env.PORT || 3007),
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: DOMAINS[domainName],
  agentApiKey: process.env.AGENT_API_KEY,
  // Origins allowed to call the API from a browser, e.g. the Vercel dashboard (comma-separated).
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
};

const agentConfig = {
  modelApiKey: process.env.MODEL_API_KEY,
  modelApiUrl: process.env.MODEL_API_URL || "https://api.groq.com/openai/v1/chat/completions",
  modelName: process.env.MODEL_NAME || "openai/gpt-oss-120b",
  productName: process.env.PRODUCT_NAME || "leather products",
  standardPrice: Number(process.env.STANDARD_UNIT_PRICE || 250),
  bulkMinimum: Number(process.env.BULK_MINIMUM_QUANTITY || 500),
  minimumPrice: Number(process.env.MINIMUM_UNIT_PRICE || 225),
};

// ---- Validate configuration ---------------------------------------------------
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const missing = [
  ["LARK_APP_ID", config.appId],
  ["LARK_APP_SECRET", config.appSecret],
  ["AGENT_API_KEY", config.agentApiKey],
  ["MODEL_API_KEY", agentConfig.modelApiKey],
]
  .filter(([, value]) => !value || value.startsWith("your_"))
  .map(([name]) => name);
if (missing.length) fail(`Fill in these values in .env: ${missing.join(", ")}`);

if (!config.domain) fail('LARK_DOMAIN must be "lark" (international) or "feishu" (China).');
if (config.agentApiKey.length < 24) fail("AGENT_API_KEY must be at least 24 characters long.");
if (
  ![agentConfig.standardPrice, agentConfig.minimumPrice, agentConfig.bulkMinimum].every(
    (n) => Number.isSafeInteger(n) && n > 0,
  ) ||
  agentConfig.minimumPrice > agentConfig.standardPrice
) {
  fail("Prices and BULK_MINIMUM_QUANTITY must be positive integers; MINIMUM_UNIT_PRICE cannot exceed STANDARD_UNIT_PRICE.");
}

// ---- Wire up -----------------------------------------------------------------
// DATA_DIR lets the customer list live on a persistent disk (e.g. a Railway volume mounted at /data).
const dataDir = process.env.DATA_DIR
  ? pathToFileURL(process.env.DATA_DIR.replace(/[\\/]*$/, "/"))
  : new URL("../data/", import.meta.url);
const lark = createLarkService({ ...config, dataDir });
const controller = createLarkController({ lark, agentConfig });

let botName;
try {
  botName = await lark.verifyCredentials();
} catch (error) {
  // Don't call process.exit() here: with fetch sockets still open it can crash Node on Windows.
  console.error(`Could not connect to Lark: ${error.message}`);
  process.exitCode = 1;
}
if (botName) start();

function start() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // CORS for the Vercel dashboard. Only origins listed in CORS_ORIGINS are allowed.
  app.use((req, res, next) => {
    const origin = req.get("origin");
    const allowed = origin && config.corsOrigins.includes(origin);
    if (allowed) {
      res.set({
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
    }
    if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
    next();
  });

  app.get("/", (req, res) =>
    res.json({
      ok: true,
      service: "Lark AI agent",
      bot: botName,
      platform: domainName,
      note: "Running. Customers chat with the bot inside Lark. Use `npm run send` or POST /lark/send to message them.",
    }),
  );
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.use("/lark", createLarkRoutes({ controller, agentApiKey: config.agentApiKey }));
  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  setupErrorMonitoring(app); // reports route errors to Better Stack Errors, then passes them on
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.expose ? error.message : "Server error." });
  });

  app.listen(config.port, config.host, () => {
    console.log(`Server listening on http://${config.host}:${config.port}`);
    console.log(`Lark platform: ${domainName} (${config.domain}) — bot "${botName}"`);
  });

  // ---- Receive messages via the long connection (no public URL or tunnel needed) ----
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      // Return right away so Lark doesn't redeliver; the agent replies a few seconds later.
      console.log(`Message received (${event?.message?.chat_type}, ${event?.message?.message_type}) from ${event?.sender?.sender_id?.open_id}`);
      controller.onMessageEvent(event);
    },
  });
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    loggerLevel: Lark.LoggerLevel.info, // shows "ws client ready" once connected
  });
  wsClient.start({ eventDispatcher });
  console.log("Opening Lark long connection — customers can message your bot once it says it's connected.");
}
