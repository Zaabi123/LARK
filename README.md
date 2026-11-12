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
backend/                           Node server: deploy to Railway
  src/
    agent/existing-agent.js        AI agent and pricing rules
    integrations/lark/
      lark.service.js              Lark API (official SDK), customer list
      lark.controller.js           inbound replies, outbound send, STOP/START
      lark.routes.js               HTTP routes and auth
    server.js                      config, CORS, long connection, startup
  send.js                          command-line sender
  railway.json                     Railway build/start/health check
frontend/                          static dashboard: deploy to Vercel
  index.html                       customer list + send a message
  build.mjs                        writes dist/ and config.js (API_URL)
  vercel.json
```

Run the commands below inside `backend/` unless a step says otherwise.

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
cd backend
npm install
npm start
```

In the Lark app, search for your bot's name and send it a message. The agent
replies.

Dashboard locally: `cd frontend`, then `npm run dev`, and open http://localhost:5310.
Add `CORS_ORIGINS=http://localhost:5310` to `backend/.env`.

## Deploy on Render (backend + dashboard)

`render.yaml` describes both services. Run only **one** copy of the backend
(stop the local server and any Railway deploy first).

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick this repo → Render reads `render.yaml`.
3. Fill in the values it asks for: `LARK_APP_ID`, `LARK_APP_SECRET`,
   `MODEL_API_KEY`. Leave `CORS_ORIGINS`, `API_URL` and the Better Stack values
   empty for now. **Apply.**
4. When both are live, copy the URLs and set:
   - `lark-backend` → Environment → `CORS_ORIGINS` = `https://lark-dashboard.onrender.com`
     (your real dashboard URL, no trailing slash)
   - `lark-dashboard` → Environment → `API_URL` = `https://lark-backend.onrender.com`,
     then **Manual Deploy** so the dashboard is rebuilt with it.
5. `AGENT_API_KEY` is generated for you: `lark-backend` → Environment → reveal
   it, then paste it into the dashboard and click **Connect**.

The backend uses the **Starter** plan: free instances sleep after 15 minutes
without web traffic, which closes the Lark long connection, and they can't have
a disk. The 1 GB disk at `/data` keeps `customers.json` (incl. STOP opt-outs)
across deploys. The dashboard is a free static site.

## Redis: conversation cache and scheduled reminders

With `REDIS_URL` set (on Render it comes from the `lark-redis` Key Value service in
`render.yaml`):

- **Conversation history** is kept in Redis (`lark:session:<customer>`, expires after 24 h without
  activity), so the agent remembers context across restarts and redeploys.
- **Scheduled reminders** run on [BullMQ](https://docs.bullmq.io) (the Node.js equivalent of Celery +
  Celery Beat). Schedule from the dashboard (*Send a message → Schedule*) or the API:

```http
POST /lark/reminders
Authorization: Bearer <AGENT_API_KEY>
Content-Type: application/json

{ "to": "user:ou_1234abcd", "text": "Reminder: payment is due tomorrow.", "at": "2026-11-20T09:00:00+05:30", "repeat": "none" }
```

`repeat` is `none` (once), `daily` or `weekly`. `GET /lark/reminders` lists them,
`DELETE /lark/reminders/<id>` cancels one (or stops a repeating one). Reminders skip customers who
sent STOP, and a failed send is retried twice (after 1 and 2 minutes).

**Better Stack:** every step is logged (`[reminder] … scheduled / sent / failed`, `[redis] …`) and
sent as events `reminder_scheduled`, `reminder_sent`, `reminder_failed`, `reminder_cancelled`.
A reminder that finally fails, and Redis errors, also go to Error tracking.

**Queue dashboard (like Celery's Flower):** open `https://<your-backend>/queues`, any username,
password = `AGENT_API_KEY`. It shows delayed, repeating, completed and failed reminder jobs with
their data and errors, and lets you retry or delete them.

Without `REDIS_URL` the app still runs: history is kept in memory and reminders are off.

## Deploy: backend on Railway, dashboard on Vercel

Run only **one** copy of the backend. Lark sends each message to one open long
connection, so stop the local server once Railway is running.

**Backend (Railway)**
1. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
2. Service → **Settings → Root Directory** = `backend`. `railway.json` sets the
   start command and the `/health` check.
3. **Variables:** copy every value from `backend/.env` (`LARK_APP_ID`,
   `LARK_APP_SECRET`, `LARK_DOMAIN`, `AGENT_API_KEY`, `MODEL_API_KEY`, the
   price settings), plus `CORS_ORIGINS` = your Vercel URL. Don't set `HOST` or
   `PORT`; Railway handles them.
4. **Keep customers across deploys:** add a **Volume** mounted at `/data` and
   set `DATA_DIR=/data`. Without it, `customers.json` (including STOP
   opt-outs) is reset on every deploy.
5. **Settings → Networking → Generate Domain** gives your backend URL.

**Dashboard (Vercel)**
1. Vercel → **Add New → Project** → import this repo → **Root Directory** = `frontend`.
2. **Environment Variables:** `API_URL` = the Railway URL. Deploy.
3. Put the Vercel URL into Railway's `CORS_ORIGINS`.
4. Open the Vercel URL, paste your `AGENT_API_KEY`, and click **Connect**.

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
