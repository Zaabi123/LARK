# Lark AI agent

Your AI sales agent on Lark (also works with Feishu 飞书). Python backend: FastAPI + Celery + Redis.

- **Inbound:** when a customer messages your bot, the agent replies in the same chat. It uses Groq to
  write the reply and follows your pricing rules, which are enforced in code.
- **Outbound:** message a customer with `POST /lark/send`, the dashboard, or `python send.py`.
- **Reminders:** schedule a message for later (once, daily or weekly). Celery Beat checks every 15 s
  and the Celery worker sends it.
- **Logs:** application, Celery, Redis and server logs each go to their **own Better Stack source**.

Incoming messages use Lark's **long connection** (WebSocket) mode: the server connects to Lark
itself, so you don't need a public URL or a tunnel.

## How it fits together

```
                    ┌──────────── lark-backend (python -m app.main) ────────────┐
 Dashboard / API ──▶│ FastAPI  /lark/send  /lark/customers  /lark/reminders      │
                    │ Lark listener (child process, WebSocket to Lark) ──▶ AI    │
                    └───────────────┬───────────────────────────────────────────┘
                                    │ customers, conversations, reminders, task queue
                              ┌─────▼─────┐
                              │   Redis   │◀── Flower (watch Celery)
                              └─────▲─────┘
                                    │ every 15 s: due reminders → send_reminder task
                    ┌───────────────┴── lark-celery (worker -B) ────────────────┐
                    │ Celery Beat + worker → sends reminders in Lark             │
                    └────────────────────────────────────────────────────────────┘
```

## Project layout

```
backend/
  app/
    main.py          FastAPI API; starts the Lark listener
    listener.py      Lark long connection: receives messages, replies via the agent
    agent.py         AI agent and pricing rules
    lark_api.py      Lark API (official lark-oapi SDK): send / reply, error explanations
    messaging.py     conversations, STOP/START, per-customer lock
    store.py         everything kept in Redis
    reminders.py     schedule / list / cancel reminders
    celery_app.py    Celery app + Beat schedule
    tasks.py         Celery tasks: dispatch due reminders, send, Redis stats, prune
    logs.py          the four Better Stack log streams + Error tracking
    config.py        settings from .env
  send.py            command-line sender
  requirements.txt
  Dockerfile
docker-compose.yml   Redis + API + Celery + Flower on your PC
render.yaml          Render Blueprint (Redis, API, Celery, Flower, dashboard)
frontend/            static dashboard (Cloudflare Pages / Render static site)
```

## 1. Set up Lark

1. Go to https://open.larksuite.com/app (Feishu: https://open.feishu.cn/app)
   and sign in with an admin account of your Lark workspace.
2. **Create Custom App** → give it a name, description and icon.
3. **Credentials:** *Credentials & Basic Info* → copy **App ID** and
   **App Secret** into `backend/.env` as `LARK_APP_ID` and `LARK_APP_SECRET`.
   For Feishu set `LARK_DOMAIN=feishu`.
4. **Enable the bot:** *Add features* → **Bot** → enable.
5. **Permissions:** *Permissions & Scopes* → add `im:message`, `im:message:send_as_bot`,
   `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`.
6. **Start the server once** (see below). Lark only lets you pick long connection mode while it's running.
7. **Events:** *Events & Callbacks* → subscription mode **Receive events through persistent
   connection** → Save → **Add events** → `im.message.receive_v1`.
8. **Publish:** *Version Management & Release* → create a version, set availability, submit.

## 2. Run it on your PC

**With Docker (Redis, API, Celery worker + Beat, Flower):**

```powershell
copy backend\.env.example backend\.env    # then fill it in
docker compose up --build
```

- API: http://localhost:3007 · Flower: http://localhost:5555 (user `admin`, password `FLOWER_PASSWORD`, default `admin`)
- While it runs, Lark sends bot messages to your PC instead of Render. Stop it with
  `docker compose down`, or set `LARK_LISTENER=off` in `backend/.env` to test without the bot.

**Without Docker** (needs a Redis at `REDIS_URL`), in `backend/`:

```powershell
py -3.13 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m app.main                                          # terminal 1: API + bot
.venv\Scripts\celery -A app.celery_app worker -B --pool=solo -l INFO      # terminal 2: Celery (Windows needs --pool=solo)
.venv\Scripts\celery -A app.celery_app flower                             # terminal 3: Flower (optional)
```

Dashboard locally: `cd frontend`, `npm run dev`, open http://localhost:5310, and add
`CORS_ORIGINS=http://localhost:5310` to `backend/.env`.

## 3. Deploy on Render

`render.yaml` creates everything. Run only **one** copy of the bot (stop any local one first).

1. Render → **New → Blueprint** → pick this repo → **Apply**. Fill in `LARK_APP_ID`,
   `LARK_APP_SECRET`, `MODEL_API_KEY`, `CORS_ORIGINS`, and the Better Stack values (below).
2. Services it creates:

| Service | What | Plan |
|---|---|---|
| `lark-redis` | Redis (Key Value), `noeviction` | Starter |
| `lark-backend` | API + Lark bot (`python -m app.main`) | Starter |
| `lark-celery` | Celery worker with Beat (`celery -A app.celery_app worker -B`) | Starter |
| `lark-flower` | Flower, to watch Celery tasks (user `admin`, password = `FLOWER_PASSWORD`, generated) | Free |
| `lark-dashboard` | static dashboard (skip if you use Cloudflare Pages) | Free |

3. `AGENT_API_KEY` is generated in the `lark-shared` environment group. Paste it into the dashboard.

**Moving from the Node version:** Render can't switch an existing service from Node to Python.
Delete the old `lark-backend` service (or rename it) before syncing the Blueprint. On first start
the new backend imports `customers.json` from `/data` into Redis if it finds it.

## 4. Better Stack: separate logs

Create **four Logs sources** in Better Stack → Telemetry → **Sources → Connect source → Python**,
and put each source's **token** and **ingesting host** in the `lark-shared` environment group:

| Better Stack source | Env vars | What you see |
|---|---|---|
| **lark-app** (application) | `BETTERSTACK_APP_TOKEN`, `BETTERSTACK_APP_HOST` | messages received, AI replies (tokens, cost), sends, STOP/START, Lark SDK |
| **lark-celery** | `BETTERSTACK_CELERY_TOKEN`, `BETTERSTACK_CELERY_HOST` | worker/Beat start, tasks, reminders scheduled / sent / failed / cancelled |
| **lark-redis** | `BETTERSTACK_REDIS_TOKEN`, `BETTERSTACK_REDIS_HOST` | connections, errors, and every minute: memory, clients, ops/s, hit rate, keys, Celery queue length |
| **lark-server** | `BETTERSTACK_SERVER_TOKEN`, `BETTERSTACK_SERVER_HOST` | HTTP access log and uvicorn server logs (health checks left out) |

**Render's own server logs** (builds, deploys, restarts, crashes): Better Stack → Sources →
Connect source → **Render** → copy the syslog endpoint. Then Render → **Workspace Settings →
Log Streams → Add** → paste it. That makes a fifth source with everything Render prints.

**Errors:** `BETTERSTACK_ERRORS_DSN` (Better Stack → Errors → application → DSN) gets crashes and
handled failures: Lark send failures, AI failures, Redis errors, reminders that gave up.

Log lines carry fields you can filter and chart on, e.g. `event = "reminder_sent"`,
`event = "ai_reply"` with `cost_usd`, `event = "redis_stats"` with `used_memory_mb`.

## 5. Send a message to a customer

| Who | Address | How you get it |
|---|---|---|
| Someone who chatted with the bot | `user:<open_id>` (starts with `ou_`) | `python send.py --list` after they message the bot |
| A group chat the bot is in | `chat:<chat_id>` (starts with `oc_`) | Add the bot to the group, @mention it once, then `python send.py --list` |
| A member of your Lark workspace | `email:<work email>` | Their Lark account email |

External customers (outside your workspace): create an external group with them, add the bot, and
message the group with `chat:<chat_id>`.

```powershell
python send.py --list
python send.py user:ou_1234abcd "Hi! Your order of 500 pieces has shipped."
python send.py --url https://lark-backend.onrender.com chat:oc_5678efgh "Hi! Your quotation is ready."
```

From your own code:

```http
POST https://lark-backend.onrender.com/lark/send
Authorization: Bearer <AGENT_API_KEY>
Content-Type: application/json

{ "to": "chat:oc_5678efgh", "text": "Hi! Your order has shipped." }
```

## 6. Reminders

```http
POST /lark/reminders
Authorization: Bearer <AGENT_API_KEY>
Content-Type: application/json

{ "to": "user:ou_1234abcd", "text": "Reminder: payment is due tomorrow.", "at": "2026-11-20T09:00:00+05:30", "repeat": "none" }
```

`repeat` is `none`, `daily` or `weekly`. `GET /lark/reminders` lists them, `DELETE /lark/reminders/<id>`
cancels one. A failed send is retried after 1 and 2 minutes; customers who sent STOP are skipped.
Watch the tasks live in **Flower**.

## Opt-out (STOP)

If a customer sends STOP (or 退订), the agent confirms, stops replying, and sends and reminders are
refused until they send START (or 订阅).

## Notes

- Customers, conversations (24 h) and reminders live in Redis, so they survive restarts and deploys.
- Messages older than 5 minutes (e.g. redelivered after the server was off) are not answered, and a
  message Lark delivers twice is answered once.
- Keep `.env` private; it is ignored by git.
