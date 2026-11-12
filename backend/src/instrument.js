// Better Stack monitoring. Loaded before the app by `node --import ./src/instrument.js src/server.js`
// (it must run before Express is loaded so requests can be traced). Each part switches on only when its
// variables are set (Railway → Variables); without them (e.g. local runs) nothing is sent.
//
//   BETTERSTACK_SOURCE_TOKEN + BETTERSTACK_INGEST_HOST (Logs source) →
//     Logs:    every console.* line, tagged with the trace_id of the request/message that caused it,
//              plus business events: message_received, ai_reply (tokens, cost), send_ok, send_failed
//   BETTERSTACK_OTEL_TOKEN + BETTERSTACK_OTEL_HOST (OpenTelemetry source; falls back to the Logs source) →
//     Traces:  HTTP requests, Express routes, outgoing calls (Groq, Lark), one span per Lark message
//     Metrics: response times, RSS/heap, CPU %, event-loop lag, and the business counters below
//   Trace sampling (optional): OTEL_TRACES_SAMPLER=parentbased_traceidratio, OTEL_TRACES_SAMPLER_ARG=0.2
//   BETTERSTACK_ERRORS_DSN → crashes and Express route errors go to Better Stack Errors
import "dotenv/config";
import { register } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";

const toUrl = (h) => h && (h.startsWith("http") ? h : `https://${h}`).replace(/\/+$/, "");
// Logs source (Logtail).
const token = process.env.BETTERSTACK_SOURCE_TOKEN;
const host = toUrl(
  process.env.BETTERSTACK_INGEST_HOST || process.env.BETTERSTACK_INGESTING_HOST || process.env.BETTERSTACK_HOST,
);
// Optional separate OpenTelemetry source for traces + metrics (e.g. "lark-backend-otel"); defaults to the Logs source.
const otelToken = process.env.BETTERSTACK_OTEL_TOKEN || token;
const otelHost = toUrl(process.env.BETTERSTACK_OTEL_HOST) || host;
const dsn = process.env.BETTERSTACK_ERRORS_DSN;
const serviceName = (process.env.OTEL_SERVICE_NAME ||= "lark-backend");

let sdk = null;
let logtail = null;
let sentry = null;

// ---- Traces + metrics (OpenTelemetry → Better Stack OTLP) -------------------------
if (otelToken && otelHost) {
  try {
    // Lets the instrumentations patch ESM imports (this app is "type": "module").
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||= otelHost;
    process.env.OTEL_EXPORTER_OTLP_HEADERS ||= `Authorization=Bearer%20${otelToken}`;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL ||= "http/protobuf";
    process.env.OTEL_TRACES_EXPORTER ||= "otlp";
    process.env.OTEL_METRICS_EXPORTER ||= "otlp";
    process.env.OTEL_LOGS_EXPORTER ||= "none"; // logs go through Logtail below
    process.env.OTEL_METRIC_EXPORT_INTERVAL ||= "30000";

    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
    sdk = new NodeSDK({
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
          "@opentelemetry/instrumentation-net": { enabled: false },
          // Railway's health checks would drown out real traffic.
          "@opentelemetry/instrumentation-http": { ignoreIncomingRequestHook: (req) => req.url === "/health" },
        }),
      ],
    });
    sdk.start();
  } catch (error) {
    console.error(`[monitoring] Better Stack traces/metrics disabled: ${error.message}`);
    sdk = null;
  }
}

// ---- Errors (Sentry-compatible DSN → Better Stack Errors) -------------------------
if (dsn) {
  try {
    sentry = await import("@sentry/node");
    sentry.init({
      dsn,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || (process.env.RENDER ? "render" : "local"),
      tracesSampleRate: 0,
      enableOpenTelemetrySetup: false, // tracing is handled by the OpenTelemetry SDK above
    });
  } catch (error) {
    console.error(`[monitoring] Better Stack Errors disabled: ${error.message}`);
    sentry = null;
  }
}

// ---- Logs (console → Better Stack Logs, linked to the active trace) -----------------
if (token && host) {
  try {
    const { Logtail } = await import("@logtail/node");
    logtail = new Logtail(token, { endpoint: host });
    const levels = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
    const text = (a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
    for (const [method, level] of Object.entries(levels)) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args); // still shows in Railway's log view
        const span = trace.getActiveSpan()?.spanContext();
        const context = span ? { trace_id: span.traceId, span_id: span.spanId } : {};
        logtail.log(args.map(text).join(" "), level, context).catch(() => {});
      };
    }
  } catch (error) {
    console.error(`[monitoring] Better Stack Logs disabled: ${error.message}`);
    logtail = null;
  }
}

// ---- Metrics ------------------------------------------------------------------------
// No-ops when the SDK isn't running.
const meter = metrics.getMeter(serviceName);
const tracer = trace.getTracer(serviceName);

// USD per 1M tokens, keyed by MODEL_NAME. Groq gpt-oss-120b: $0.15 in / $0.60 out (check groq.com/pricing).
export const PRICES = {
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
};

const messagesReceived = meter.createCounter("lark_messages_received", { description: "Customer messages received from Lark" });
const messagesSent = meter.createCounter("lark_messages_sent", { description: "Messages delivered to Lark" });
const sendFailures = meter.createCounter("lark_send_failures", { description: "Failed sends to Lark" });
const aiReplies = meter.createCounter("ai_replies", { description: "AI model replies generated" });
const aiErrors = meter.createCounter("ai_errors", { description: "AI model calls that failed" });
const aiTokens = meter.createCounter("ai_tokens", { description: "AI tokens used" });
const aiCost = meter.createCounter("ai_cost_usd", { description: "Estimated AI spend", unit: "USD" });
const aiLatency = meter.createHistogram("ai_reply_duration_seconds", { description: "AI model call time", unit: "s" });

// RAM / CPU / event-loop lag of this process.
const rss = meter.createObservableGauge("process_memory_rss_bytes", { description: "Resident set size", unit: "By" });
const heap = meter.createObservableGauge("process_memory_heap_used_bytes", { description: "V8 heap used", unit: "By" });
const cpu = meter.createObservableGauge("process_cpu_percent", { description: "CPU use since last export", unit: "%" });
const lag = meter.createObservableGauge("event_loop_lag_p99_ms", { description: "Event-loop delay, 99th percentile", unit: "ms" });
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastCpu = process.cpuUsage();
let lastTime = process.hrtime.bigint();
meter.addBatchObservableCallback(
  (result) => {
    const mem = process.memoryUsage();
    result.observe(rss, mem.rss);
    result.observe(heap, mem.heapUsed);
    const now = process.hrtime.bigint();
    const used = process.cpuUsage(lastCpu);
    const elapsedUs = Number(now - lastTime) / 1000;
    if (elapsedUs > 0) result.observe(cpu, ((used.user + used.system) / elapsedUs) * 100);
    lastCpu = process.cpuUsage();
    lastTime = now;
    result.observe(lag, loopDelay.percentile(99) / 1e6);
    loopDelay.reset();
  },
  [rss, heap, cpu, lag],
);

/**
 * Business event as a structured log record in the Logs source (for messages/day, failed sends and
 * cost/day charts). Fields are queryable, e.g. event = 'ai_reply', cost_usd. Never pass message text.
 */
export function logEvent(event, fields = {}) {
  if (!logtail) return;
  const span = trace.getActiveSpan()?.spanContext();
  const context = { event, ...fields, ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}) };
  logtail.info(`[event] ${event}`, context).catch(() => {});
}

export function recordMessageReceived(chatType = "unknown") {
  messagesReceived.add(1, { chat_type: chatType });
  logEvent("message_received", { chat_type: chatType });
}

export function recordMessageSent(kind) {
  messagesSent.add(1, { kind });
  logEvent("send_ok", { kind });
}

export function recordSendFailure(kind, error) {
  const code = String(error?.code ?? error?.status ?? "error");
  sendFailures.add(1, { kind, code });
  logEvent("send_failed", { kind, code, reason: String(error?.message ?? "").slice(0, 120) });
}

/** Call after a successful model call with its OpenAI-style `usage`. */
export function recordAiReply(model, usage, seconds) {
  aiLatency.record(seconds, { model, outcome: "ok" });
  aiReplies.add(1, { model });
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  aiTokens.add(input, { model, type: "input" });
  aiTokens.add(output, { model, type: "output" });
  const price = PRICES[model];
  const cost = price ? (input * price.input + output * price.output) / 1e6 : null;
  if (price) aiCost.add(cost, { model });
  else console.warn(`[monitoring] no price for model "${model}" — add it to PRICES in src/instrument.js`);
  logEvent("ai_reply", { model, input_tokens: input, output_tokens: output, cost_usd: cost, duration_s: seconds });
}

export function recordAiError(model, seconds) {
  aiLatency.record(seconds, { model, outcome: "error" });
  aiErrors.add(1, { model });
  logEvent("ai_failed", { model, duration_s: seconds });
}

/** Runs `fn` inside a new trace span, so its logs and outgoing calls are grouped together. */
export function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

// ---- Wiring helpers ------------------------------------------------------------------
/** Sends buffered logs/errors/traces (max 3 s). Call before the process exits. */
export async function flushMonitoring() {
  await Promise.race([
    Promise.all([logtail?.flush(), sentry?.flush(2000), sdk?.shutdown()].filter(Boolean)),
    new Promise((r) => setTimeout(r, 3000)),
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
  `[monitoring] Better Stack logs: ${logtail ? "on" : "off"}, traces+metrics: ${sdk ? "on" : "off"}, errors: ${sentry ? "on" : "off"}`,
);
