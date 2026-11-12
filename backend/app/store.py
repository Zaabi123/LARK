"""Everything the app keeps, stored in Redis (shared by the API, the Lark listener and Celery).

  lark:customers                 hash  customer key -> JSON {optedOut, firstSeen, lastSeen, chatType}
  lark:session:<customer>        str   conversation state JSON, expires 24 h after the last message
  lark:seen:<message_id>         str   duplicate guard for Lark redeliveries (10 min)
  lark:reminder:<id>             str   reminder JSON
  lark:reminders:due             zset  id -> due time (unix seconds), read by Celery Beat
  lark:reminders:all             zset  id -> due/last time, for listing in the dashboard

Redis problems are logged to the "redis" Better Stack stream.
"""
import json
import os
import time
from datetime import datetime, timezone

import redis

from .config import settings
from .logs import event, redis_log, report_error

SESSION_TTL = 24 * 3600
SEEN_TTL = 10 * 60
HISTORY_DAYS = 7  # sent / failed / cancelled reminders stay listed this long

_client: redis.Redis | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_timeout=5,
            socket_connect_timeout=5,
            health_check_interval=30,
            retry_on_timeout=True,
            client_name=f"lark-{os.getenv('LARK_PROCESS', 'app')}",
        )
    return _client


def check_connection(component: str) -> bool:
    """Log whether Redis is reachable (called at startup by each process)."""
    try:
        info = get_redis().info("server")
        event(
            redis_log, "redis_connected",
            f"[redis] {component} connected to Redis {info.get('redis_version')}",
            component=component, redis_version=info.get("redis_version"),
        )
        return True
    except redis.RedisError as error:
        redis_log.error("[redis] %s cannot reach Redis: %s", component, error)
        report_error(error, component=f"redis-{component}")
        return False


def _failed(action: str, error: Exception, **fields) -> None:
    redis_log.error("[redis] %s failed: %s", action, error, extra={"action": action, **fields})
    report_error(error, component="redis", action=action, **fields)


# ---- Customers ----------------------------------------------------------------------
def touch_customer(key: str, **changes) -> dict:
    r = get_redis()
    existing = r.hget("lark:customers", key)
    now = now_iso()
    customer = {"optedOut": False, "firstSeen": now, **(json.loads(existing) if existing else {}), **changes, "lastSeen": now}
    r.hset("lark:customers", key, json.dumps(customer))
    if not existing:
        from .logs import app_log

        app_log.info("New Lark customer: %s", key)
    return customer


def get_customer(key: str) -> dict | None:
    raw = get_redis().hget("lark:customers", key)
    return json.loads(raw) if raw else None


def list_customers() -> dict:
    return {k: json.loads(v) for k, v in get_redis().hgetall("lark:customers").items()}


def import_old_customers() -> None:
    """One-time import of data/customers.json (Node version) when Redis has no customers yet."""
    path = os.path.join(settings.data_dir, "customers.json")
    r = get_redis()
    if not os.path.exists(path) or r.exists("lark:customers"):
        return
    try:
        with open(path, encoding="utf-8") as f:
            customers = json.load(f)
        if customers:
            r.hset("lark:customers", mapping={k: json.dumps(v) for k, v in customers.items()})
            redis_log.info("[redis] imported %d customers from %s", len(customers), path)
    except (OSError, ValueError, redis.RedisError) as error:
        _failed("import customers.json", error)


# ---- Conversation sessions (cache) ---------------------------------------------------
def get_session(key: str) -> dict | None:
    try:
        raw = get_redis().get(f"lark:session:{key}")
        return json.loads(raw) if raw else None
    except redis.RedisError as error:
        _failed("session read", error, customer=key)  # carry on with a fresh conversation
        return None


def save_session(key: str, session: dict) -> None:
    try:
        get_redis().set(f"lark:session:{key}", json.dumps(session), ex=SESSION_TTL)
    except redis.RedisError as error:
        _failed("session write", error, customer=key)


def delete_session(key: str) -> None:
    try:
        get_redis().delete(f"lark:session:{key}")
    except redis.RedisError as error:
        _failed("session delete", error, customer=key)


def first_time_seen(message_id: str) -> bool:
    """True the first time a Lark message id is seen (Lark may deliver an event twice)."""
    try:
        return bool(get_redis().set(f"lark:seen:{message_id}", 1, nx=True, ex=SEEN_TTL))
    except redis.RedisError as error:
        _failed("duplicate check", error)
        return True


# ---- Reminders -------------------------------------------------------------------------
def save_reminder(rem: dict) -> None:
    r = get_redis()
    pipe = r.pipeline()
    pipe.set(f"lark:reminder:{rem['id']}", json.dumps(rem))
    when = datetime.fromisoformat(rem["at"].replace("Z", "+00:00")).timestamp()
    pipe.zadd("lark:reminders:all", {rem["id"]: when})
    if rem["state"] in ("scheduled", "repeating"):
        pipe.zadd("lark:reminders:due", {rem["id"]: when})
    else:
        pipe.zrem("lark:reminders:due", rem["id"])
    pipe.execute()


def get_reminder(rid: str) -> dict | None:
    raw = get_redis().get(f"lark:reminder:{rid}")
    return json.loads(raw) if raw else None


def claim_due_reminders(limit: int = 100) -> list[str]:
    """Atomically take reminders that are due, so two Beat ticks never send one twice."""
    r = get_redis()
    claimed = []
    for rid in r.zrangebyscore("lark:reminders:due", 0, time.time(), start=0, num=limit):
        if r.zrem("lark:reminders:due", rid):  # only one caller wins the ZREM
            claimed.append(rid)
    return claimed


def list_reminders() -> list[dict]:
    r = get_redis()
    ids = r.zrange("lark:reminders:all", 0, -1)
    if not ids:
        return []
    raws = r.mget([f"lark:reminder:{i}" for i in ids])
    return [json.loads(x) for x in raws if x]


def prune_reminders() -> int:
    """Forget finished reminders older than HISTORY_DAYS."""
    r = get_redis()
    cutoff = time.time() - HISTORY_DAYS * 86400
    removed = 0
    for rid in r.zrangebyscore("lark:reminders:all", 0, cutoff):
        rem = get_reminder(rid)
        if rem is None or rem["state"] in ("sent", "failed", "cancelled"):
            r.delete(f"lark:reminder:{rid}")
            r.zrem("lark:reminders:all", rid)
            removed += 1
    return removed
