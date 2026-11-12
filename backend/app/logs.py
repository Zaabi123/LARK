"""Logging: four separate Better Stack sources, plus Error tracking.

Each log stream has its own Better Stack source (Telemetry -> Sources -> Connect source -> Python),
so they show up separately in Better Stack:

  stream    logger names                        env vars
  app       lark.app, Lark (SDK), httpx         BETTERSTACK_APP_TOKEN    + BETTERSTACK_APP_HOST
  celery    lark.celery, celery.*               BETTERSTACK_CELERY_TOKEN + BETTERSTACK_CELERY_HOST
  redis     lark.redis                          BETTERSTACK_REDIS_TOKEN  + BETTERSTACK_REDIS_HOST
  server    uvicorn, uvicorn.access/.error      BETTERSTACK_SERVER_TOKEN + BETTERSTACK_SERVER_HOST

Render's own platform logs (builds, deploys, restarts) are sent with a Render Log Stream; see README.
A stream without its token is only printed to the console (Render's log view). Everything is always
printed to the console as well.

BETTERSTACK_ERRORS_DSN -> crashes and handled failures go to Better Stack Error tracking.
"""
import logging
import os
import sys

from .config import settings

STREAMS = {
    "app": ["lark.app", "Lark", "httpx"],
    "celery": ["lark.celery", "celery"],
    "redis": ["lark.redis"],
    "server": ["uvicorn", "uvicorn.access", "uvicorn.error", "fastapi"],
}

app_log = logging.getLogger("lark.app")
celery_log = logging.getLogger("lark.celery")
redis_log = logging.getLogger("lark.redis")

_configured: set[str] = set()
_handlers: dict[str, logging.Handler] = {}
_sentry = None


def _source(stream: str):
    token = os.getenv(f"BETTERSTACK_{stream.upper()}_TOKEN", "").strip()
    host = os.getenv(f"BETTERSTACK_{stream.upper()}_HOST", "").strip()
    if stream == "app" and not token:  # the Node version used one source for everything
        token = os.getenv("BETTERSTACK_SOURCE_TOKEN", "").strip()
        host = os.getenv("BETTERSTACK_INGEST_HOST", "").strip()
    if not (token and host):
        return None
    return token, host if host.startswith("http") else f"https://{host}"


class _Console(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        stream = getattr(record, "stream", None) or "app"
        return f"[{stream}] {record.levelname.lower()}: {record.getMessage()}" + (
            f"\n{self.formatException(record.exc_info)}" if record.exc_info else ""
        )


class _NoHealth(logging.Filter):
    """Drop access-log lines for Render's /health checks (every few seconds)."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not (record.name == "uvicorn.access" and "/health" in str(record.args))


class _Tag(logging.Filter):
    """Adds record.stream so console lines show where they go."""

    def __init__(self, stream: str):
        super().__init__()
        self.stream = stream

    def filter(self, record: logging.LogRecord) -> bool:
        record.stream = self.stream
        return True


def setup_logging(*streams: str) -> None:
    """Attach console + Better Stack handlers to the given streams (idempotent)."""
    global _sentry
    summary = []
    for stream in streams:
        if stream in _configured:
            continue
        _configured.add(stream)
        # Filters sit on the handlers so records from child loggers (celery.worker...) are tagged too.
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(_Console())
        handlers: list[logging.Handler] = [console]
        source = _source(stream)
        if source:
            from logtail import LogtailHandler

            _handlers[stream] = LogtailHandler(source_token=source[0], host=source[1])
            handlers.append(_handlers[stream])
        for h in handlers:
            h.addFilter(_Tag(stream))
            if stream == "server":
                h.addFilter(_NoHealth())
        summary.append(f"{stream}: {'Better Stack' if source else 'console only'}")
        for name in STREAMS[stream]:
            lg = logging.getLogger(name)
            lg.handlers = handlers[:]  # replace default/Celery console handlers with ours
            lg.setLevel(logging.INFO)
            lg.propagate = False
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per HTTP call is too noisy

    dsn = os.getenv("BETTERSTACK_ERRORS_DSN", "").strip()
    if dsn and _sentry is None:
        import sentry_sdk

        sentry_sdk.init(dsn=dsn, environment=settings.environment, traces_sample_rate=0)
        _sentry = sentry_sdk
    if summary:
        app_log.info("[monitoring] %s; errors: %s", ", ".join(summary), "on" if _sentry else "off")


def report_error(error: BaseException, **extra) -> None:
    """Send a caught (handled) error to Better Stack Error tracking."""
    if _sentry is None:
        return
    with _sentry.new_scope() as scope:
        for key, value in extra.items():
            scope.set_extra(key, value)
        _sentry.capture_exception(error)


def event(logger: logging.Logger, name: str, message: str = "", level: int = logging.INFO, **fields) -> None:
    """A structured log line ("business event") with queryable fields, e.g. event = 'reminder_sent'."""
    logger.log(level, message or f"[event] {name}", extra={"event": name, **fields})


def flush() -> None:
    for handler in _handlers.values():
        try:
            handler.flush()
        except Exception:
            pass
    if _sentry is not None:
        _sentry.flush(2)
