// Scheduled reminder messages (BullMQ on Redis: the Node.js counterpart of Celery + Celery Beat).
//  - one-time: a delayed job that fires at the chosen time
//  - repeating (daily / weekly): a BullMQ job scheduler ("beat") that creates a job each period
// The worker runs inside this server (one instance on Render) and sends through the same path as
// POST /lark/send, so STOP opt-outs are respected and every send is logged/traced in Better Stack.
import { randomUUID } from "node:crypto";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { createRedis } from "./redis.js";
import { logEvent, reportError, withSpan } from "./instrument.js";
import { MAX_TEXT_LENGTH, parseCustomerKey } from "./integrations/lark/lark.service.js";
import { OptedOutError } from "./integrations/lark/lark.controller.js";

const QUEUE = "lark-reminders";
const REPEAT_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const ATTEMPTS = 3;

export class ReminderInputError extends Error {
  name = "ReminderInputError";
}

export function createReminders({ redisUrl, deliver }) {
  const queue = new Queue(QUEUE, {
    connection: createRedis(redisUrl, "reminders-queue", { maxRetriesPerRequest: null }),
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: "exponential", delay: 60_000 }, // retry after 1 min, then 2 min
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 }, // keep a week of history for the dashboard
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  queue.on("error", (error) => console.error(`[reminder] queue error: ${error.message}`));

  const worker = new Worker(
    QUEUE,
    (job) =>
      withSpan("reminder.send", { "reminder.id": job.id, "lark.customer": job.data.to }, async () => {
        try {
          const sent = await deliver(job.data.to, job.data.text);
          return { messageId: sent.id };
        } catch (error) {
          // A customer who sent STOP won't be messaged; retrying would not help.
          if (error instanceof OptedOutError) throw new UnrecoverableError(error.message);
          throw error;
        }
      }),
    {
      connection: createRedis(redisUrl, "reminders-worker", { maxRetriesPerRequest: null }),
      concurrency: 5,
    },
  );

  const info = (job) => ({ reminder_id: job.id, scheduler: job.repeatJobKey ?? undefined, customer: job.data?.to });
  worker.on("ready", () => console.log("[reminder] worker ready — scheduled reminders will be sent"));
  worker.on("completed", (job, result) => {
    console.log(`[reminder] ${job.id} sent to ${job.data.to}`);
    logEvent("reminder_sent", { ...info(job), message_id: result?.messageId });
  });
  worker.on("failed", (job, error) => {
    if (!job) return;
    const final = error instanceof UnrecoverableError || error.name === "UnrecoverableError" || job.attemptsMade >= ATTEMPTS;
    console.error(
      `[reminder] ${job.id} to ${job.data.to} failed (attempt ${job.attemptsMade}/${ATTEMPTS}${final ? ", giving up" : ", will retry"}): ${error.message}`,
    );
    logEvent("reminder_failed", { ...info(job), attempt: job.attemptsMade, final, reason: error.message.slice(0, 120) });
    if (final) reportError(error, { component: "reminders", ...info(job) });
  });
  worker.on("error", (error) => console.error(`[reminder] worker error: ${error.message}`));

  // ---- API used by the routes ---------------------------------------------------
  function parse(body) {
    const to = parseCustomerKey(body?.to);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const at = new Date(body?.at);
    const repeat = body?.repeat ? String(body.repeat) : "none";
    if (!to) throw new ReminderInputError("`to` must be user:<open_id>, chat:<chat_id> or email:<address>.");
    if (!text || text.length > MAX_TEXT_LENGTH) throw new ReminderInputError(`\`text\` must be 1-${MAX_TEXT_LENGTH} characters.`);
    if (Number.isNaN(at.getTime())) throw new ReminderInputError("`at` must be a date/time, e.g. 2026-11-20T09:00:00+05:30.");
    if (at.getTime() < Date.now() - 60_000) throw new ReminderInputError("`at` is in the past.");
    if (at.getTime() > Date.now() + MAX_AHEAD_MS) throw new ReminderInputError("`at` must be within a year.");
    if (repeat !== "none" && !REPEAT_MS[repeat]) throw new ReminderInputError("`repeat` must be none, daily or weekly.");
    return { to, text, at, repeat };
  }

  /** POST body { to, text, at, repeat? } → { id, at, repeat } */
  async function schedule(body) {
    const { to, text, at, repeat } = parse(body);
    const data = { to, text, repeat, createdAt: new Date().toISOString() };
    let id;
    if (repeat === "none") {
      const job = await queue.add("reminder", data, { delay: Math.max(0, at.getTime() - Date.now()) });
      id = job.id;
    } else {
      id = `repeat-${randomUUID()}`;
      await queue.upsertJobScheduler(id, { every: REPEAT_MS[repeat], startDate: at }, { name: "reminder", data });
    }
    console.log(`[reminder] ${id} scheduled for ${to} at ${at.toISOString()}${repeat !== "none" ? ` (${repeat})` : ""}`);
    logEvent("reminder_scheduled", { reminder_id: id, customer: to, repeat, due_at: at.toISOString() });
    return { id, to, at: at.toISOString(), repeat };
  }

  /** Repeating schedules, upcoming one-time reminders, and the last week of sent/failed ones. */
  async function list() {
    const schedulers = (await queue.getJobSchedulers(0, 199)).map((s) => ({
      id: s.key,
      to: s.template?.data?.to,
      text: s.template?.data?.text,
      repeat: s.template?.data?.repeat,
      at: s.next ? new Date(s.next).toISOString() : null,
      state: "repeating",
    }));
    const jobs = await queue.getJobs(["delayed", "waiting", "active", "completed", "failed"], 0, 199);
    const states = await Promise.all(jobs.map((j) => j.getState()));
    const items = jobs
      // The next run of a repeating schedule is already shown on its scheduler row.
      .map((j, i) => ({ job: j, state: states[i] }))
      .filter(({ job, state }) => !(job.repeatJobKey && (state === "delayed" || state === "waiting")))
      .map(({ job, state }) => ({
        id: job.id,
        to: job.data.to,
        text: job.data.text,
        repeat: job.repeatJobKey ? job.data.repeat : "none",
        at: new Date(job.finishedOn ?? job.timestamp + (job.delay || 0)).toISOString(),
        state: state === "completed" ? "sent" : state === "delayed" || state === "waiting" ? "scheduled" : state,
        error: job.failedReason || undefined,
      }));
    return [...schedulers, ...items].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  /** Cancel a one-time reminder that hasn't been sent, or stop a repeating one. */
  async function cancel(id) {
    if (String(id).startsWith("repeat-") && (await queue.removeJobScheduler(id))) {
      console.log(`[reminder] ${id} repeating reminder stopped`);
      logEvent("reminder_cancelled", { reminder_id: id });
      return true;
    }
    const job = await queue.getJob(id);
    if (!job || !["delayed", "waiting"].includes(await job.getState())) return false;
    await job.remove();
    console.log(`[reminder] ${id} cancelled`);
    logEvent("reminder_cancelled", { reminder_id: id, customer: job.data.to });
    return true;
  }

  async function close() {
    await worker.close(); // lets a reminder that is being sent finish
    await queue.close();
  }

  return { schedule, list, cancel, close, queue };
}
