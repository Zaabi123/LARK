"""Customer conversations, shared by the Lark listener, the API and Celery.

A Redis lock per customer keeps messages to/from one customer in order, even across processes
(the listener replying while Celery sends a reminder to the same person).
"""
import json
import re

from . import store
from .agent import empty_session, run_agent_turn
from .config import settings
from .lark_api import reply_text, send_text
from .logs import app_log, event

OPT_OUT = re.compile(r"^(stop|unsubscribe|退订)$", re.I)
OPT_IN = re.compile(r"^(start|subscribe|订阅)$", re.I)


class OptedOutError(Exception):
    def __init__(self, key: str):
        super().__init__(f"{key} sent STOP. They must send START before you can message them.")
        self.key = key


def _lock(key: str):
    return store.get_redis().lock(f"lark:lock:{key}", timeout=90, blocking_timeout=90)


def _session(key: str) -> dict:
    return store.get_session(key) or empty_session()


def deliver(key: str, text: str) -> dict:
    """Send text to a customer and add it to their conversation. Raises OptedOutError after STOP."""
    if (store.get_customer(key) or {}).get("optedOut"):
        raise OptedOutError(key)
    with _lock(key):
        sent = send_text(key, text)
        store.touch_customer(key)
        state = _session(key)
        state["history"] = [*state["history"], {"role": "assistant", "content": text[:1000]}][-10:]
        store.save_session(key, state)
        return sent


def key_for(message, sender) -> str:
    if message.chat_type == "group":
        return f"chat:{message.chat_id}"
    return f"user:{sender.sender_id.open_id}"


def text_of(message) -> str:
    """Plain text of an incoming message, with @mention placeholders removed."""
    if message.message_type != "text":
        return ""
    try:
        text = str(json.loads(message.content).get("text", ""))
    except (ValueError, TypeError):
        return ""
    return re.sub(r"\s+", " ", re.sub(r"@_user_\d+", "", text)).strip()


def handle_inbound(message, sender) -> None:
    key = key_for(message, sender)
    text = text_of(message)
    profile = {"chatType": message.chat_type}
    with _lock(key):
        if OPT_OUT.match(text):
            store.touch_customer(key, **profile, optedOut=True)
            store.delete_session(key)
            event(app_log, "opt_out", f"{key} opted out (STOP)", customer=key)
            reply_text(message.message_id, "You've been unsubscribed and won't receive further messages. Send START to subscribe again.")
            return
        if OPT_IN.match(text):
            store.touch_customer(key, **profile, optedOut=False)
            event(app_log, "opt_in", f"{key} opted in (START)", customer=key)
            reply_text(message.message_id, "You're subscribed again. How can we help you today?")
            return

        customer = store.touch_customer(key, **profile)
        if customer.get("optedOut"):
            return
        if not text:
            reply_text(message.message_id, "Thanks for your message! Please type your question as text and we'll be happy to help.")
            return

        result = run_agent_turn(text, _session(key), settings)
        app_log.info("[ai] replied to %s (%s)", key, result["source"])
        reply_text(message.message_id, result["reply"])
        store.save_session(key, result["next_state"])
