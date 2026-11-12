"""Celery tasks. Their logs go to the "celery" Better Stack stream (Redis stats to "redis")."""
from datetime import datetime, timezone

import redis
from celery.exceptions import MaxRetriesExceededError

from . import store
from .celery_app import celery
from .lark_api import LarkError
from .logs import celery_log, event, redis_log, report_error
from .messaging import OptedOutError, deliver
from .reminders import REPEAT, iso

RETRY_DELAYS = [60, 120]  # retry a failed send after 1 min, then 2 min


@celery.task(name="app.tasks.dispatch_due_reminders", ignore_result=True)
def dispatch_due_reminders() -> int:
    """Beat, every 15 s: queue a send_reminder task for each reminder that is due."""
    due = store.claim_due_reminders()
    for rid in due:
        send_reminder.delay(rid)
    if due:
        celery_log.info("[beat] %d reminder(s) due, queued for sending", len(due))
    return len(due)


@celery.task(name="app.tasks.send_reminder", bind=True, max_retries=len(RETRY_DELAYS), acks_late=True)
def send_reminder(self, rid: str) -> None:
    rem = store.get_reminder(rid)
    if not rem or rem["state"] not in ("scheduled", "repeating"):
        return  # cancelled meanwhile
    to, attempt = rem["to"], self.request.retries + 1
    fields = {"reminder_id": rid, "customer": to, "repeat": rem["repeat"], "attempt": attempt}
    try:
        sent = deliver(to, rem["text"])
    except OptedOutError as error:  # retrying would not help
        _finish_failed(rem, str(error), fields, final=True)
        return
    except (LarkError, redis.RedisError) as error:
        final = self.request.retries >= len(RETRY_DELAYS)
        _finish_failed(rem, str(error), fields, final=final)
        if not final:
            try:
                raise self.retry(countdown=RETRY_DELAYS[self.request.retries], exc=error)
            except MaxRetriesExceededError:
                pass
        return

    rem["sentCount"] = rem.get("sentCount", 0) + 1
    rem["lastSentAt"] = store.now_iso()
    rem.pop("error", None)
    if rem["repeat"] in REPEAT:
        # Next run: keep the same time of day; skip runs missed while the worker was down.
        nxt = datetime.fromisoformat(rem["at"].replace("Z", "+00:00"))
        while nxt <= datetime.now(timezone.utc):
            nxt += REPEAT[rem["repeat"]]
        rem["at"] = iso(nxt)
    else:
        rem["state"] = "sent"
        rem["at"] = rem["lastSentAt"]
    store.save_reminder(rem)
    event(
        celery_log, "reminder_sent",
        f"[reminder] {rid} sent to {to}" + (f"; next run {rem['at']}" if rem["repeat"] in REPEAT else ""),
        message_id=sent["id"], **fields,
    )


def _finish_failed(rem: dict, reason: str, fields: dict, final: bool) -> None:
    rid = rem["id"]
    celery_log.error(
        "[reminder] %s to %s failed (attempt %s/%s%s): %s",
        rid, rem["to"], fields["attempt"], len(RETRY_DELAYS) + 1, ", giving up" if final else ", will retry", reason,
        extra={"event": "reminder_failed", "final": final, **fields},
    )
    if not final:
        return
    report_error(RuntimeError(f"Reminder {rid} failed: {reason}"), component="reminders", **fields)
    if rem["repeat"] in REPEAT:  # a repeating reminder tries again next period
        nxt = datetime.fromisoformat(rem["at"].replace("Z", "+00:00"))
        while nxt <= datetime.now(timezone.utc):
            nxt += REPEAT[rem["repeat"]]
        rem.update(at=iso(nxt), error=reason)
    else:
        rem.update(state="failed", error=reason, at=store.now_iso())
    store.save_reminder(rem)


@celery.task(name="app.tasks.redis_stats", ignore_result=True)
def redis_stats() -> dict:
    """Beat, every 60 s: Redis health as one structured log line in the "redis" stream."""
    try:
        r = store.get_redis()
        info = r.info()
        hits, misses = info.get("keyspace_hits", 0), info.get("keyspace_misses", 0)
        stats = {
            "used_memory_mb": round(info.get("used_memory", 0) / 1048576, 2),
            "maxmemory_mb": round(info.get("maxmemory", 0) / 1048576, 2),
            "maxmemory_policy": info.get("maxmemory_policy"),
            "connected_clients": info.get("connected_clients"),
            "ops_per_sec": info.get("instantaneous_ops_per_sec"),
            "hit_rate": round(hits / (hits + misses), 3) if hits + misses else None,
            "evicted_keys": info.get("evicted_keys"),
            "keys": r.dbsize(),
            "customers": r.hlen("lark:customers"),
            "reminders_due": r.zcard("lark:reminders:due"),
            "celery_queue_length": r.llen("celery"),
        }
    except redis.RedisError as error:
        redis_log.error("[redis] stats failed: %s", error)
        report_error(error, component="redis-stats")
        return {}
    event(
        redis_log, "redis_stats",
        "[redis] memory {used_memory_mb} MB, clients {connected_clients}, {ops_per_sec} ops/s, "
        "hit rate {hit_rate}, keys {keys}, reminders due {reminders_due}, celery queue {celery_queue_length}".format(**stats),
        **stats,
    )
    if stats["maxmemory_policy"] and stats["maxmemory_policy"] != "noeviction":
        redis_log.warning("[redis] maxmemory-policy is %s; set it to noeviction so Celery tasks are never evicted", stats["maxmemory_policy"])
    return stats


@celery.task(name="app.tasks.prune_reminders", ignore_result=True)
def prune_reminders() -> int:
    removed = store.prune_reminders()
    if removed:
        celery_log.info("[reminder] pruned %d finished reminder(s) older than 7 days", removed)
    return removed
