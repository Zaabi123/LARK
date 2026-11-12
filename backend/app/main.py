"""HTTP API (FastAPI) + starts the Lark long-connection listener in a child process.

  python -m app.main        start everything for the web service (Render start command)

Endpoints (same as the Node version, so the dashboard and send.py keep working):
  GET  /  /health
  POST /lark/send               {to, text}                       Bearer AGENT_API_KEY
  GET  /lark/customers
  GET  /lark/reminders
  POST /lark/reminders          {to, text, at, repeat?}
  DELETE /lark/reminders/{id}
"""
import hmac
import multiprocessing
import os
import subprocess
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import reminders, store
from .config import settings
from .lark_api import MAX_TEXT_LENGTH, LarkError, parse_customer_key, verify_credentials
from .logs import app_log, flush, report_error, setup_logging
from .messaging import OptedOutError, deliver

state = {"bot": None, "listener": None, "celery": None}


def _start_listener() -> None:
    from .listener import run

    proc = multiprocessing.get_context("spawn").Process(target=run, name="lark-listener", daemon=True)
    proc.start()
    state["listener"] = proc


def _start_celery() -> None:
    """Celery worker + Beat as a child process, so one (free) web service runs everything.
    --pool=solo keeps it to one process to stay within 512 MB."""
    celery_cmd = [sys.executable, "-m", "celery", "-A", "app.celery_app"]
    schedule = "/tmp/celerybeat-schedule" if os.name != "nt" else os.path.join(os.getenv("TEMP", "."), "celerybeat-schedule")
    if os.name != "nt":
        cmds = [celery_cmd + ["worker", "-B", "--pool=solo", "--loglevel=INFO", f"--schedule={schedule}"]]
    else:  # Windows doesn't allow -B: run Beat as its own process
        cmds = [celery_cmd + ["worker", "--pool=solo", "--loglevel=INFO"], celery_cmd + ["beat", "--loglevel=INFO", f"--schedule={schedule}"]]
    state["celery"] = [subprocess.Popen(cmd) for cmd in cmds]
    app_log.info("[celery] worker + Beat started inside the web service (pid %s)", ", ".join(str(p.pid) for p in state["celery"]))


def _celery_running() -> bool:
    return bool(state["celery"]) and all(p.poll() is None for p in state["celery"])


@asynccontextmanager
async def lifespan(_app: FastAPI):
    setup_logging("app", "server", "redis", "celery")
    os.environ["LARK_PROCESS"] = "api"
    if store.check_connection("api"):
        store.import_old_customers()
    if os.getenv("CELERY_IN_WEB", "on") != "off":
        _start_celery()
    try:
        state["bot"] = await run_in_threadpool(verify_credentials)
        app_log.info("Lark platform: %s — bot \"%s\"", settings.lark_domain_name, state["bot"])
        if os.getenv("LARK_LISTENER", "on") != "off":
            _start_listener()
    except LarkError as error:
        app_log.error("Could not connect to Lark: %s", error)
        report_error(error, stage="startup")
    yield
    if state["listener"] and state["listener"].is_alive():
        state["listener"].terminate()
    for proc in state["celery"] or []:
        if proc.poll() is None:
            proc.terminate()
    flush()


app = FastAPI(title="Lark AI agent", lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)


def agent_only(request: Request) -> None:
    header = request.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else ""
    if not hmac.compare_digest(token.encode(), settings.agent_api_key.encode()):
        raise HTTPException(401, "Missing or invalid AGENT_API_KEY bearer token.")


@app.exception_handler(HTTPException)
async def _http_error(_req, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(Exception)
async def _server_error(req: Request, exc: Exception):
    app_log.error("%s %s failed: %s", req.method, req.url.path, exc)
    report_error(exc, path=req.url.path)
    return JSONResponse({"error": "Server error."}, status_code=500)


@app.get("/")
def root():
    proc = state["listener"]
    return {
        "ok": True,
        "service": "Lark AI agent",
        "bot": state["bot"],
        "platform": settings.lark_domain_name,
        "listener": "running" if proc and proc.is_alive() else "stopped",
        "celery": "running" if _celery_running() else "stopped",
        "note": "Running. Customers chat with the bot inside Lark. Use send.py or POST /lark/send to message them.",
    }


@app.get("/health")
def health():
    proc = state["listener"]
    if proc is not None and not proc.is_alive():  # makes Render restart the service
        return JSONResponse({"ok": False, "error": "Lark listener stopped"}, status_code=503)
    if state["celery"] is not None and not _celery_running():
        return JSONResponse({"ok": False, "error": "Celery stopped"}, status_code=503)
    return {"ok": True}


@app.post("/lark/send", dependencies=[Depends(agent_only)])
def send(body: dict):
    key = parse_customer_key(body.get("to"))
    text = body.get("text").strip() if isinstance(body.get("text"), str) else ""
    if not key:
        raise HTTPException(400, "`to` must be user:<open_id>, chat:<chat_id> or email:<address>.")
    if not text or len(text) > MAX_TEXT_LENGTH:
        raise HTTPException(400, f"`text` must be 1-{MAX_TEXT_LENGTH} characters.")
    try:
        result = deliver(key, text)
    except OptedOutError:
        raise HTTPException(409, "This customer sent STOP. They must send START before you can message them.")
    except LarkError as error:
        raise HTTPException(400 if error.status and error.status < 500 else 502, str(error))
    return {"sent": True, "to": key, "id": result["id"]}


@app.get("/lark/customers", dependencies=[Depends(agent_only)])
def customers():
    return store.list_customers()


@app.get("/lark/reminders", dependencies=[Depends(agent_only)])
def list_reminders():
    return reminders.list_all()


@app.post("/lark/reminders", dependencies=[Depends(agent_only)], status_code=201)
def create_reminder(body: dict):
    try:
        return reminders.schedule(body)
    except reminders.ReminderInputError as error:
        raise HTTPException(400, str(error))


@app.delete("/lark/reminders/{rid}", dependencies=[Depends(agent_only)])
def cancel_reminder(rid: str):
    if not reminders.cancel(rid):
        raise HTTPException(404, "No upcoming reminder with that id (it may have been sent already).")
    return {"cancelled": True, "id": rid}


def main() -> None:
    problems = settings.validate()
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(1)
    setup_logging("app", "server", "redis", "celery")
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_config=None, proxy_headers=True, forwarded_allow_ips="*")


if __name__ == "__main__":
    main()
