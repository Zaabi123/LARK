// Bull Board at /queues: a web page to watch the reminder queue (like Flower for Celery).
// Shows scheduled, repeating, sent and failed reminders, and lets you retry or delete them.
// Protected by HTTP Basic auth: any username, password = AGENT_API_KEY.
import { timingSafeEqual } from "node:crypto";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

const BASE_PATH = "/queues";

function basicAuth(password) {
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const [scheme, encoded] = (req.get("authorization") || "").split(" ");
    const given = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : "";
    const actual = Buffer.from(given);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Lark reminders", charset="UTF-8"').status(401).send("Password = AGENT_API_KEY");
  };
}

export function mountQueueBoard(app, { queue, password }) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BASE_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(queue, { displayName: "Lark reminders" })],
    serverAdapter,
    options: { uiConfig: { boardTitle: "Lark AI Agent" } },
  });
  app.use(BASE_PATH, basicAuth(password), serverAdapter.getRouter());
  console.log(`[reminder] queue dashboard at ${BASE_PATH} (password: AGENT_API_KEY)`);
}
