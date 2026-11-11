// Better Stack monitoring. Each part switches on only when its variable is set (Railway → Variables):
//   BETTERSTACK_SOURCE_TOKEN + BETTERSTACK_HOST → every console.* line goes to Better Stack Logs
//   BETTERSTACK_ERRORS_DSN                     → crashes and Express route errors go to Better Stack Errors
// Without them (e.g. local runs) nothing is loaded or sent.

const token = process.env.BETTERSTACK_SOURCE_TOKEN;
const host = process.env.BETTERSTACK_HOST;
const dsn = process.env.BETTERSTACK_ERRORS_DSN;

let logtail = null;
let sentry = null;

if (dsn) {
  try {
    sentry = await import("@sentry/node");
    sentry.init({ dsn, environment: process.env.RAILWAY_ENVIRONMENT_NAME || "local", tracesSampleRate: 0 });
  } catch (error) {
    console.error(`[monitoring] Better Stack Errors disabled: ${error.message}`);
    sentry = null;
  }
}

if (token && host) {
  try {
    const { Logtail } = await import("@logtail/node");
    logtail = new Logtail(token, { endpoint: host.startsWith("http") ? host : `https://${host}` });
    const levels = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
    const text = (a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
    for (const [method, level] of Object.entries(levels)) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args); // still shows in Railway's log view
        logtail[level](args.map(text).join(" ")).catch(() => {});
      };
    }
  } catch (error) {
    console.error(`[monitoring] Better Stack Logs disabled: ${error.message}`);
    logtail = null;
  }
}

/** Sends buffered logs/errors (max 2 s). Call before the process exits. */
export async function flushMonitoring() {
  await Promise.race([
    Promise.all([logtail?.flush(), sentry?.flush(2000)].filter(Boolean)),
    new Promise((r) => setTimeout(r, 2000)),
  ]).catch(() => {});
}

/** Register after your routes, before your own error handler. */
export function setupErrorMonitoring(app) {
  if (sentry) sentry.setupExpressErrorHandler(app);
}

// On Railway redeploys/restarts, send what's buffered, then exit as Node would.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => flushMonitoring().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
}

console.log(
  `[monitoring] Better Stack logs: ${logtail ? "on" : "off"}, errors: ${sentry ? "on" : "off"}`,
);
