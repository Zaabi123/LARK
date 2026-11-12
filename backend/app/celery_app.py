"""Celery: worker + Beat for reminders, with Redis as the broker.

  celery -A app.celery_app worker -B --loglevel=INFO      worker with Beat built in (Render)
  celery -A app.celery_app flower                         Flower: web UI to watch tasks

Beat schedule:
  every 15 s  dispatch_due_reminders  -> queues send_reminder for each reminder that is due
  every 60 s  redis_stats             -> Redis memory/clients/ops/hit-rate to the "redis" log stream
  hourly      prune_reminders         -> forget sent/failed reminders older than 7 days
"""
import os

from celery import Celery
from celery.signals import after_setup_logger, after_setup_task_logger, worker_ready, worker_shutdown

from .config import settings

os.environ.setdefault("LARK_PROCESS", "celery")

celery = Celery("lark", broker=settings.redis_url, include=["app.tasks"])
celery.conf.update(
    task_ignore_result=True,  # results aren't needed; keeps Redis small
    task_acks_late=True,  # a reminder interrupted by a restart is sent again rather than lost
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    worker_hijack_root_logger=False,
    worker_send_task_events=True,  # for Flower
    task_send_sent_event=True,
    broker_connection_retry_on_startup=True,
    broker_transport_options={"visibility_timeout": 3600},
    timezone="UTC",
    beat_schedule={
        "dispatch-due-reminders": {"task": "app.tasks.dispatch_due_reminders", "schedule": 15.0},
        "redis-stats": {"task": "app.tasks.redis_stats", "schedule": 60.0},
        "prune-reminders": {"task": "app.tasks.prune_reminders", "schedule": 3600.0},
    },
)
app = celery  # so "celery -A app.celery_app" finds it


@after_setup_logger.connect
@after_setup_task_logger.connect
def _logging(**_):
    from .logs import setup_logging

    setup_logging("celery", "app", "redis")


@worker_ready.connect
def _ready(**_):
    from . import store
    from .logs import celery_log

    store.check_connection("celery")
    celery_log.info("[celery] worker ready — reminders are checked every 15 s by Celery Beat")


@worker_shutdown.connect
def _shutdown(**_):
    from .logs import flush

    flush()
