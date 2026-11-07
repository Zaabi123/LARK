# Lark AI agent

Your AI sales agent on Lark (also works with Feishu 飞书).

- **Outbound:** your agent or app messages a customer with `POST /lark/send`,
  or from the command line with `npm run send`.
- **Inbound:** when a customer messages your bot, the agent replies in the same
  chat. It uses Groq to write the reply and follows your pricing rules, which
  are enforced in code.

Incoming messages use Lark's **long connection** (WebSocket) mode: the server
connects to Lark itself, so you don't need a public URL or a tunnel.

## Project layout

```
src/
  agent/existing-agent.js          AI agent and pricing rules
  integrations/lark/
    lark.service.js                Lark API (official SDK), customer list
    lark.controller.js             inbound replies, outbound send, STOP/START
    lark.routes.js                 HTTP routes and auth
  server.js                        config, long connection, startup
send.js                            command-line sender
```

## 1. Set up Lark

1. Go to https://open.larksuite.com/app (Feishu: https://open.feishu.cn/app)
   and sign in with an admin account of your Lark workspace.
2. **Create Custom App** → give it a name, description and icon.
3. **Credentials:** *Credentials & Basic Info* → copy **App ID** and
   **App Secret** into `.env` as `LARK_APP_ID` and `LARK_APP_SECRET`.
   For Feishu set `LARK_DOMAIN=feishu`.
4. **Enable the bot:** *Add features* → **Bot** → enable.
5. **Permissions:** *Permissions & Scopes* → add:
   - `im:message` (read and send messages)
   - `im:message:send_as_bot` (send messages as the bot)
   - `im:message.p2p_msg:readonly` (receive 1-to-1 messages)
   - `im:message.group_at_msg:readonly` (receive group messages that @mention the bot)
6. **Start the server once** (`npm start`, see below). Lark only lets you pick
   long connection mode while it's running.
7. **Events:** *Events & Callbacks* → *Event configuration* → subscription
   mode **Receive events through persistent connection** (使用长连接接收事件)
   → Save. Then **Add events** → `im.message.receive_v1` (Message received).
8. **Publish:** *Version Management & Release* → create a version, set
   availability to the people who should be able to chat with the bot, and
   submit. Changes don't take effect until the version is approved/published.

## 2. Run it

```powershell
npm install
npm start
```

In the Lark app, search for your bot's name and send it a message. The agent
replies.

## 3. Send a message to a customer

| Who | Address | How you get it |
|---|---|---|
| Someone who chatted with the bot | `user:<open_id>` (starts with `ou_`) | `npm run send -- --list` after they message the bot |
| A group chat the bot is in | `chat:<chat_id>` (starts with `oc_`) | Add the bot to the group, @mention it once, then `npm run send -- --list` |
| A member of your Lark workspace | `email:<work email>` | Their Lark account email |

**External customers** (outside your Lark workspace): a custom app can only
chat 1-to-1 with people in your workspace. For an external customer, create an
external group with them, add the bot (the app must allow external groups),
and message the group with `chat:<chat_id>`.

With the server running, in a second terminal:

```powershell
npm run send -- --list
npm run send -- user:ou_1234abcd "Hi! Your order of 500 pieces has shipped."
npm run send -- chat:oc_5678efgh "Hi! Your quotation is ready."
npm run send -- email:buyer@yourcompany.com "Hi! Your quotation is ready."
```

From your own code:

```http
POST http://127.0.0.1:3007/lark/send
Authorization: Bearer <AGENT_API_KEY from .env>
Content-Type: application/json

{ "to": "chat:oc_5678efgh", "text": "Hi! Your order has shipped." }
```

In a group, the bot only receives messages that @mention it.

## Opt-out (STOP)

If a customer sends STOP (or 退订), the agent confirms, stops replying, and
`/lark/send` refuses to message them until they send START (or 订阅).

## Notes

- Conversation history is kept in memory and resets on restart. The customer
  list, with opt-out status, is saved to `data/customers.json`.
- Messages older than 5 minutes (e.g. redelivered after the server was off)
  are not answered.
- Keep `data/` and `.env` private; both are ignored by git.
