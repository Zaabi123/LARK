// Connects Lark to the AI agent:
//  - inbound: customer messages your bot -> agent -> reply in the same chat
//  - outbound: your agent/app -> POST /lark/send -> customer
import { emptySession, runAgentTurn } from "../../agent/existing-agent.js";
import { LarkError, MAX_TEXT_LENGTH, parseCustomerKey } from "./lark.service.js";
import { recordMessageReceived, withSpan } from "../../instrument.js";

const OPT_OUT = /^(stop|unsubscribe|退订)$/i;
const OPT_IN = /^(start|subscribe|订阅)$/i;

const sessionLifetimeMs = 24 * 60 * 60 * 1000;
const maxProcessed = 10_000;
const maxMessageAgeMs = 5 * 60 * 1000;

export function createLarkController({ lark, agentConfig }) {
  const sessions = new Map();
  const queues = new Map();
  const processed = new Set();

  function getSession(key) {
    const previous = sessions.get(key);
    return previous && Date.now() - previous.updatedAt < sessionLifetimeMs ? previous : emptySession();
  }

  /** One message at a time per customer, so replies stay in order. */
  function enqueue(key, work) {
    const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, task);
    const cleanup = () => {
      if (queues.get(key) === task) queues.delete(key);
    };
    task.then(cleanup, cleanup);
    return task;
  }

  /** Which customer key an incoming message belongs to. */
  function keyFor(event) {
    const { message, sender } = event;
    if (message.chat_type === "group") return `chat:${message.chat_id}`;
    return `user:${sender.sender_id?.open_id}`;
  }

  /** Plain text of an incoming message, with @mention placeholders removed. */
  function textOf(message) {
    if (message.message_type !== "text") return "";
    try {
      const text = String(JSON.parse(message.content).text ?? "");
      return text.replace(/@_user_\d+/g, "").replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  }

  // ---- Inbound -----------------------------------------------------------------
  async function handleInbound(event) {
    const { message } = event;
    const key = keyFor(event);
    const text = textOf(message);
    const reply = (content) => lark.replyText(message.message_id, content);
    const profile = { chatType: message.chat_type };

    if (OPT_OUT.test(text)) {
      await lark.touchCustomer(key, { ...profile, optedOut: true });
      sessions.delete(key);
      await reply("You've been unsubscribed and won't receive further messages. Send START to subscribe again.");
      return;
    }
    if (OPT_IN.test(text)) {
      await lark.touchCustomer(key, { ...profile, optedOut: false });
      await reply("You're subscribed again. How can we help you today?");
      return;
    }

    const customer = await lark.touchCustomer(key, profile);
    if (customer.optedOut) return;

    if (!text) {
      await reply("Thanks for your message! Please type your question as text and we'll be happy to help.");
      return;
    }

    const { reply: answer, nextState, source } = await runAgentTurn(text, getSession(key), agentConfig);
    console.log(`[ai] replied to ${key} (${source})`);
    await reply(answer);
    sessions.set(key, nextState);
  }

  /** Called by the long connection for every im.message.receive_v1 event. */
  function onMessageEvent(event) {
    const message = event?.message;
    if (!message?.message_id || processed.has(message.message_id)) return;
    if (event.sender?.sender_type !== "user") return; // ignore other bots (and ourselves)
    // Lark redelivers events that were missed while the server was offline; don't answer stale ones.
    if (Number(message.create_time) && Date.now() - Number(message.create_time) > maxMessageAgeMs) return;

    processed.add(message.message_id);
    if (processed.size > maxProcessed) processed.delete(processed.values().next().value);

    const key = keyFor(event);
    recordMessageReceived(message.chat_type);
    // One trace per customer message: its logs, the Groq call and the Lark reply are grouped under it.
    withSpan("lark.message", { "lark.chat_type": message.chat_type, "lark.customer": key }, () =>
      enqueue(key, () => handleInbound(event)),
    ).catch((error) => {
      console.error(`Could not reply to ${key}: ${error.message}`);
    });
  }

  // ---- Outbound ----------------------------------------------------------------
  /** POST /lark/send — { "to": "user:ou_..." | "chat:oc_..." | "email:a@b.com", "text": "Hello!" } */
  async function sendToCustomer(req, res) {
    const key = parseCustomerKey(req.body?.to);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!key) {
      return res.status(400).json({ error: "`to` must be user:<open_id>, chat:<chat_id> or email:<address>." });
    }
    if (!text || text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `\`text\` must be 1-${MAX_TEXT_LENGTH} characters.` });
    }
    if ((await lark.getCustomer(key))?.optedOut) {
      return res.status(409).json({ error: "This customer sent STOP. They must send START before you can message them." });
    }

    try {
      const result = await enqueue(key, async () => {
        const sent = await lark.sendText(key, text);
        await lark.touchCustomer(key);
        // Keep it in the conversation so the agent has context when the customer replies.
        const state = getSession(key);
        sessions.set(key, {
          ...state,
          history: [...state.history, { role: "assistant", content: text.slice(0, 1000) }].slice(-10),
          updatedAt: Date.now(),
        });
        return sent;
      });
      res.json({ sent: true, to: key, id: result.id });
    } catch (error) {
      const status = error instanceof LarkError && error.status && error.status < 500 ? 400 : 502;
      res.status(status).json({ error: error.message });
    }
  }

  /** GET /lark/customers */
  async function listCustomers(req, res) {
    res.json(await lark.listCustomers());
  }

  return { onMessageEvent, sendToCustomer, listCustomers };
}
