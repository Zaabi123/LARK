// Talks to the Lark Open Platform API (via the official SDK) and stores the customer directory.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as lark from "@larksuiteoapi/node-sdk";

export const MAX_TEXT_LENGTH = 4000;

export class LarkError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Explain the Lark errors people hit most often during setup. */
function explain(code, message) {
  switch (code) {
    case 10003:
    case 10014:
      return `${message} — Check LARK_APP_ID and LARK_APP_SECRET, and LARK_DOMAIN (lark vs feishu).`;
    case 99991672:
    case 99991679:
    case 230027:
      return `${message} — In the developer console → your app → Permissions & Scopes, add im:message and im:message:send_as_bot, then publish a new app version.`;
    case 230002:
      return `${message} — The bot is not in this chat. Add the bot to the group first.`;
    case 230013:
      return `${message} — This user can't see the bot. In the developer console → Version Management, make the app available to them (or to all members) and publish.`;
    case 99992361:
    case 99992364:
      return `${message} — Unknown or invalid user ID / email.`;
    default:
      return message;
  }
}

/**
 * Customers are addressed by a key:
 *   user:<open_id>     1-to-1 chat with someone who messaged the bot (open_id starts with ou_)
 *   chat:<chat_id>     a group chat the bot is in (chat_id starts with oc_)
 *   email:<address>    a member of your Lark tenant, by work email
 * A bare ID is guessed from its prefix.
 */
export function parseCustomerKey(input) {
  const value = String(input ?? "").trim();
  const match = value.match(/^(user|chat|email):(.+)$/);
  let [type, id] = match ? [match[1], match[2].trim()] : [null, value];
  if (!type) type = id.startsWith("oc_") ? "chat" : id.includes("@") ? "email" : "user";
  if (!id || id.length > 254 || /\s/.test(id)) return null;
  if (type === "email" && !/^[^@]+@[^@]+\.[^@]+$/.test(id)) return null;
  return `${type}:${id}`;
}

const RECEIVE_ID_TYPE = { user: "open_id", chat: "chat_id", email: "email" };

export function createLarkService({ appId, appSecret, domain, dataDir }) {
  const client = new lark.Client({
    appId,
    appSecret,
    domain,
    appType: lark.AppType.SelfBuild,
    loggerLevel: lark.LoggerLevel.warn,
  });

  /** Unwrap an SDK call: throw a readable LarkError on any failure. */
  async function call(promise) {
    let body;
    try {
      body = await promise;
    } catch (error) {
      const data = error.response?.data ?? {};
      const message = data.msg || error.message;
      throw new LarkError(explain(data.code, message), { code: data.code, status: error.response?.status });
    }
    if (body?.code) throw new LarkError(explain(body.code, body.msg), { code: body.code, status: 400 });
    return body?.data ?? {};
  }

  /** Confirm the credentials work and return the bot's name. */
  async function verifyCredentials() {
    const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new LarkError(explain(body.code, body.msg || `HTTP ${response.status}`), { code: body.code });
    }
    // Bot info (name) — optional, needs the bot capability enabled.
    const info = await fetch(`${domain}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${body.tenant_access_token}` },
      signal: AbortSignal.timeout(15_000),
    })
      .then((r) => r.json())
      .catch(() => ({}));
    if (info.code !== 0) {
      throw new LarkError("Credentials work, but the app has no bot. In the developer console → your app → Add features → Bot, enable it and publish a new version.");
    }
    return info.bot?.app_name || "your bot";
  }

  // ---- Sending -----------------------------------------------------------------
  const textContent = (text) => JSON.stringify({ text: String(text).slice(0, MAX_TEXT_LENGTH) });

  /** Send a new message to a customer key (user:..., chat:... or email:...). */
  async function sendText(key, text) {
    const type = key.slice(0, key.indexOf(":"));
    const id = key.slice(key.indexOf(":") + 1);
    const data = await call(
      client.im.v1.message.create({
        params: { receive_id_type: RECEIVE_ID_TYPE[type] },
        data: { receive_id: id, msg_type: "text", content: textContent(text) },
      }),
    );
    return { id: data.message_id, chatId: data.chat_id };
  }

  /** Reply to a specific incoming message (shows as a reply in the same chat). */
  async function replyText(messageId, text) {
    const data = await call(
      client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: textContent(text) },
      }),
    );
    return { id: data.message_id };
  }

  // ---- Customer directory ------------------------------------------------------
  const customersFile = new URL("customers.json", dataDir);
  let customers = {};
  let loaded = false;
  let saveChain = Promise.resolve();

  async function load() {
    if (!loaded) {
      try {
        customers = JSON.parse(await readFile(customersFile, "utf8"));
      } catch {}
      loaded = true;
    }
    return customers;
  }

  function save() {
    saveChain = saveChain
      .then(async () => {
        await mkdir(dataDir, { recursive: true });
        await writeFile(customersFile, `${JSON.stringify(customers, null, 2)}\n`);
      })
      .catch((error) => console.error(`Could not save customers: ${error.message}`));
    return saveChain;
  }

  async function touchCustomer(key, changes = {}) {
    await load();
    const existing = customers[key];
    customers[key] = {
      optedOut: false,
      firstSeen: new Date().toISOString(),
      ...existing,
      ...changes,
      lastSeen: new Date().toISOString(),
    };
    if (!existing) console.log(`New Lark customer: ${key}${changes.name ? ` (${changes.name})` : ""}`);
    await save();
    return customers[key];
  }

  async function getCustomer(key) {
    return (await load())[key] ?? null;
  }

  async function listCustomers() {
    return { ...(await load()) };
  }

  return { client, verifyCredentials, sendText, replyText, touchCustomer, getCustomer, listCustomers };
}
