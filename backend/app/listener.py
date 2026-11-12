"""Lark long connection (WebSocket): receives customer messages and answers them.

Runs in its own process, started by the API (app.main), because the Lark SDK's WebSocket client
needs its own event loop. Only ONE copy may run: Lark sends each message to one open connection.
"""
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor

MAX_MESSAGE_AGE_S = 5 * 60


def run() -> None:
    os.environ["LARK_PROCESS"] = "listener"
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

    from . import store
    from .config import settings
    from .logs import app_log, event, flush, report_error, setup_logging
    from .messaging import handle_inbound

    setup_logging("app", "redis")
    logging.getLogger("Lark").setLevel(logging.INFO)  # shows "connected to wss://..." once connected
    store.check_connection("listener")
    pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="lark-reply")

    def answer(message, sender) -> None:
        try:
            handle_inbound(message, sender)
        except Exception as error:
            app_log.error("Could not reply to %s: %s", getattr(sender.sender_id, "open_id", "?"), error)
            report_error(error, component="inbound")

    def on_message(data: P2ImMessageReceiveV1) -> None:
        message, sender = data.event.message, data.event.sender
        if not message or not message.message_id or sender.sender_type != "user":
            return  # ignore other bots (and ourselves)
        # Lark redelivers events missed while the server was offline; don't answer stale ones.
        created = int(message.create_time or 0) / 1000
        if created and time.time() - created > MAX_MESSAGE_AGE_S:
            return
        if not store.first_time_seen(message.message_id):
            return
        event(
            app_log, "message_received",
            f"Message received ({message.chat_type}, {message.message_type}) from {sender.sender_id.open_id}",
            chat_type=message.chat_type,
        )
        # Return right away so Lark doesn't redeliver; the agent replies a few seconds later.
        pool.submit(answer, message, sender)

    handler = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(on_message).build()
    ws = lark.ws.Client(
        settings.lark_app_id,
        settings.lark_app_secret,
        event_handler=handler,
        domain=settings.lark_domain,
        log_level=lark.LogLevel.INFO,
    )
    app_log.info("Opening Lark long connection — customers can message your bot once it says it's connected.")
    try:
        ws.start()  # blocks, reconnects automatically
    finally:
        flush()
