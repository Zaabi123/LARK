"""Lark Open Platform API (official lark-oapi SDK): send and reply to messages."""
import json
import re

import httpx
import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
    ReplyMessageRequest,
    ReplyMessageRequestBody,
)

from .config import settings
from .logs import app_log, event, report_error

MAX_TEXT_LENGTH = 4000
RECEIVE_ID_TYPE = {"user": "open_id", "chat": "chat_id", "email": "email"}


class LarkError(Exception):
    def __init__(self, message: str, code=None, status=None):
        super().__init__(message)
        self.code = code
        self.status = status


def explain(code, message: str) -> str:
    """Explain the Lark errors people hit most often during setup."""
    hints = {
        (10003, 10014): "Check LARK_APP_ID and LARK_APP_SECRET, and LARK_DOMAIN (lark vs feishu).",
        (99991672, 99991679, 230027): "In the developer console → your app → Permissions & Scopes, add im:message and im:message:send_as_bot, then publish a new app version.",
        (230002,): "The bot is not in this chat. Add the bot to the group first.",
        (230013,): "This user can't see the bot. In the developer console → Version Management, make the app available to them (or to all members) and publish.",
        (230001, 99992361, 99992364): "Unknown or invalid user ID / email. For email:… the person must be a member of your Lark workspace (not an external contact) and inside the app's availability (developer console → Version Management & Release → Availability, then publish).",
    }
    for codes, hint in hints.items():
        if code in codes:
            return f"{message} — {hint}"
    return message


def parse_customer_key(value) -> str | None:
    """user:<open_id>, chat:<chat_id> or email:<address>; a bare ID is guessed from its prefix."""
    value = str(value or "").strip()
    m = re.match(r"^(user|chat|email):(.+)$", value)
    type_, id_ = (m.group(1), m.group(2).strip()) if m else (None, value)
    if not type_:
        type_ = "chat" if id_.startswith("oc_") else "email" if "@" in id_ else "user"
    if not id_ or len(id_) > 254 or re.search(r"\s", id_):
        return None
    if type_ == "email" and not re.match(r"^[^@]+@[^@]+\.[^@]+$", id_):
        return None
    return f"{type_}:{id_}"


_client = None


def client() -> lark.Client:
    global _client
    if _client is None:
        _client = (
            lark.Client.builder()
            .app_id(settings.lark_app_id)
            .app_secret(settings.lark_app_secret)
            .domain(settings.lark_domain)
            .log_level(lark.LogLevel.WARNING)
            .build()
        )
    return _client


def _content(text: str) -> str:
    return json.dumps({"text": str(text)[:MAX_TEXT_LENGTH]}, ensure_ascii=False)


def _tracked(kind: str, target: str, call) -> dict:
    """Run a send, log the outcome (application stream) and report failures to Error tracking."""
    try:
        resp = call()
        if not resp.success():
            raise LarkError(explain(resp.code, resp.msg or "Lark API error"), code=resp.code, status=400)
    except LarkError as error:
        _send_failed(kind, target, error)
        raise
    except Exception as error:  # network problems etc.
        wrapped = LarkError(str(error), status=502)
        _send_failed(kind, target, wrapped)
        raise wrapped from error
    event(app_log, "send_ok", f"[send] {kind} delivered to {target}", kind=kind, customer=target)
    return resp.data


def _send_failed(kind: str, target: str, error: LarkError) -> None:
    event(
        app_log, "send_failed", f"[send] {kind} FAILED to {target}: {error}", level=40,
        kind=kind, customer=target, code=str(error.code or error.status or "error"),
    )
    report_error(error, kind=kind, target=target, lark_code=error.code)


def send_text(key: str, text: str) -> dict:
    """Send a new message to a customer key. Returns {"id", "chatId"}."""
    type_, id_ = key.split(":", 1)
    req = (
        CreateMessageRequest.builder()
        .receive_id_type(RECEIVE_ID_TYPE[type_])
        .request_body(CreateMessageRequestBody.builder().receive_id(id_).msg_type("text").content(_content(text)).build())
        .build()
    )
    data = _tracked("send", key, lambda: client().im.v1.message.create(req))
    return {"id": data.message_id, "chatId": data.chat_id}


def reply_text(message_id: str, text: str) -> dict:
    """Reply to an incoming message (shows as a reply in the same chat)."""
    req = (
        ReplyMessageRequest.builder()
        .message_id(message_id)
        .request_body(ReplyMessageRequestBody.builder().msg_type("text").content(_content(text)).build())
        .build()
    )
    data = _tracked("reply", f"message {message_id}", lambda: client().im.v1.message.reply(req))
    return {"id": data.message_id}


def verify_credentials() -> str:
    """Confirm the credentials work and return the bot's name."""
    base = settings.lark_domain
    resp = httpx.post(
        f"{base}/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": settings.lark_app_id, "app_secret": settings.lark_app_secret},
        timeout=15,
    )
    body = resp.json() if resp.content else {}
    if body.get("code") != 0 or not body.get("tenant_access_token"):
        raise LarkError(explain(body.get("code"), body.get("msg") or f"HTTP {resp.status_code}"), code=body.get("code"))
    try:
        info = httpx.get(
            f"{base}/open-apis/bot/v3/info",
            headers={"Authorization": f"Bearer {body['tenant_access_token']}"},
            timeout=15,
        ).json()
    except Exception:
        info = {}
    if info.get("code") != 0:
        raise LarkError(
            "Credentials work, but the app has no bot. In the developer console → your app → "
            "Add features → Bot, enable it and publish a new version."
        )
    return (info.get("bot") or {}).get("app_name") or "your bot"
