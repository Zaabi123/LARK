"""Scheduled reminders: validation and storage (used by the API). Celery Beat + the worker send them."""
import uuid
from datetime import datetime, timedelta, timezone

from . import store
from .lark_api import MAX_TEXT_LENGTH, parse_customer_key
from .logs import celery_log, event

REPEAT = {"daily": timedelta(days=1), "weekly": timedelta(weeks=1)}
MAX_AHEAD = timedelta(days=366)


class ReminderInputError(ValueError):
    pass


def _parse_at(value) -> datetime:
    try:
        at = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise ReminderInputError("`at` must be a date/time, e.g. 2026-11-20T09:00:00+05:30.") from None
    if at.tzinfo is None:
        raise ReminderInputError("`at` must include a time zone, e.g. 2026-11-20T09:00:00+05:30 or ...Z.")
    return at.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def schedule(body: dict) -> dict:
    to = parse_customer_key((body or {}).get("to"))
    text = (body or {}).get("text")
    text = text.strip() if isinstance(text, str) else ""
    repeat = str((body or {}).get("repeat") or "none")
    if not to:
        raise ReminderInputError("`to` must be user:<open_id>, chat:<chat_id> or email:<address>.")
    if not text or len(text) > MAX_TEXT_LENGTH:
        raise ReminderInputError(f"`text` must be 1-{MAX_TEXT_LENGTH} characters.")
    at = _parse_at((body or {}).get("at"))
    now = datetime.now(timezone.utc)
    if at < now - timedelta(minutes=1):
        raise ReminderInputError("`at` is in the past.")
    if at > now + MAX_AHEAD:
        raise ReminderInputError("`at` must be within a year.")
    if repeat != "none" and repeat not in REPEAT:
        raise ReminderInputError("`repeat` must be none, daily or weekly.")

    rid = f"{'repeat' if repeat != 'none' else 'rem'}-{uuid.uuid4().hex[:12]}"
    rem = {
        "id": rid, "to": to, "text": text, "repeat": repeat, "at": iso(at),
        "state": "repeating" if repeat != "none" else "scheduled",
        "createdAt": iso(now), "sentCount": 0,
    }
    store.save_reminder(rem)
    event(
        celery_log, "reminder_scheduled",
        f"[reminder] {rid} scheduled for {to} at {rem['at']}{f' ({repeat})' if repeat != 'none' else ''}",
        reminder_id=rid, customer=to, repeat=repeat, due_at=rem["at"],
    )
    return {"id": rid, "to": to, "at": rem["at"], "repeat": repeat}


def list_all() -> list[dict]:
    fields = ("id", "to", "text", "repeat", "at", "state", "error")
    return sorted(
        ({k: r.get(k) for k in fields if r.get(k) is not None} for r in store.list_reminders()),
        key=lambda r: r["at"],
    )


def cancel(rid: str) -> bool:
    rem = store.get_reminder(rid)
    if not rem or rem["state"] not in ("scheduled", "repeating"):
        return False
    rem["state"] = "cancelled"
    store.save_reminder(rem)
    event(celery_log, "reminder_cancelled", f"[reminder] {rid} cancelled", reminder_id=rid, customer=rem["to"])
    return True
