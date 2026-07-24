import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabaseConnection, waitForPostgres } from "./db/client.js";
import { BudgetGuardrail, startDailyBudget } from "./jobs/budget.js";
import {
  ConsentDeletionWorker,
  startConsentDeletionPolling,
} from "./jobs/consent-deletion.js";
import {
  MetricsRunner,
  startDailyMetrics,
} from "./jobs/metrics-runner.js";
import {
  RetentionPurgeJob,
  startDailyRetention,
} from "./jobs/retention.js";
import {
  LangfuseForwardWorker,
  startLangfuseForwardPolling,
} from "./outbox/langfuse-worker.js";
import { OutboxWorker, startOutboxPolling } from "./outbox/worker.js";
import {
  PrivacyDeletionWorker,
  startPrivacyDeletionPolling,
} from "./privacy/erasure.js";
import { loadObservabilityConfig } from "./sinks/observability-config.js";
import { createObservabilitySpanSink } from "./sinks/observability-spans.js";
import { createTelemetrySinks } from "./sinks/telemetry-sinks.js";
import { SystemClock } from "./telemetry/clock.js";
import { loadEventCatalogRegistry } from "./telemetry/event-catalog.js";

const config = loadConfig();
const connection = createDatabaseConnection(config.databaseUrl);
const catalogs = loadEventCatalogRegistry();
const catalog = catalogs.current;
const observability = loadObservabilityConfig();
const spans = createObservabilitySpanSink(config);
const app = buildApp(config, { connection, catalog, spans });
const sinks = createTelemetrySinks(config, observability);
const clock = new SystemClock();
const worker = new OutboxWorker({
  pool: connection.pool,
  catalogs,
  clock,
  posthog: sinks.posthog,
  otel: sinks.otel,
  spans,
  retryBaseMilliseconds: config.outboxRetryBaseMs,
  retryMaxMilliseconds: config.outboxRetryMaxMs,
});
const langfuseWorker = new LangfuseForwardWorker({
  pool: connection.pool,
  langfuse: sinks.langfuse,
  clock,
  observability,
  retryBaseMilliseconds: config.outboxRetryBaseMs,
  retryMaxMilliseconds: config.outboxRetryMaxMs,
});
const privacyDeletionWorker = new PrivacyDeletionWorker({
  pool: connection.pool,
  clock,
  analytics: sinks.posthog,
  traces: sinks.otel,
  retryBaseMilliseconds: config.outboxRetryBaseMs,
  retryMaxMilliseconds: config.outboxRetryMaxMs,
});
const retentionJob = new RetentionPurgeJob({
  pool: connection.pool,
  clock,
  spans,
});
const consentDeletionWorker = new ConsentDeletionWorker({
  pool: connection.pool,
  catalog,
  clock,
});
const metricsRunner = new MetricsRunner({ pool: connection.pool, clock, spans });
const budgetGuardrail = new BudgetGuardrail({
  pool: connection.pool,
  observability,
  clock,
  spans,
});
let polling: ReturnType<typeof startOutboxPolling> | undefined;
let langfusePolling: ReturnType<typeof startLangfuseForwardPolling> | undefined;
let consentDeletionPolling:
  | ReturnType<typeof startConsentDeletionPolling>
  | undefined;
let privacyDeletionPolling:
  | ReturnType<typeof startPrivacyDeletionPolling>
  | undefined;
let retentionSchedule: ReturnType<typeof startDailyRetention> | undefined;
let metricsSchedule: ReturnType<typeof startDailyMetrics> | undefined;
let budgetSchedule: ReturnType<typeof startDailyBudget> | undefined;

try {
  await waitForPostgres(connection.pool);
  await app.listen({ host: config.host, port: config.port });
  polling = startOutboxPolling(worker, config.outboxPollIntervalMs, () => {
    console.error("Telemetry outbox worker cycle failed.");
  });
  langfusePolling = startLangfuseForwardPolling(
    langfuseWorker,
    config.outboxPollIntervalMs,
    () => {
      console.error("Langfuse forward worker cycle failed.");
    },
  );
  privacyDeletionPolling = startPrivacyDeletionPolling(
    privacyDeletionWorker,
    config.outboxPollIntervalMs,
    () => {
      console.error("Privacy deletion worker cycle failed.");
    },
  );
  consentDeletionPolling = startConsentDeletionPolling(
    consentDeletionWorker,
    config.outboxPollIntervalMs,
    () => {
      console.error("Consent deletion worker cycle failed.");
    },
  );
  retentionSchedule = startDailyRetention(retentionJob, () => {
    console.error("Daily retention purge failed.");
  });
  metricsSchedule = startDailyMetrics(metricsRunner, () => {
    console.error("Daily metrics run failed.");
  });
  budgetSchedule = startDailyBudget(budgetGuardrail, () => {
    console.error("Daily budget guardrail failed.");
  });
} catch (_error) {
  console.error("Learning-signal service failed to start.");
  await connection.pool.end();
  process.exitCode = 1;
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await budgetSchedule?.stop();
  await metricsSchedule?.stop();
  await retentionSchedule?.stop();
  await consentDeletionPolling?.stop();
  await privacyDeletionPolling?.stop();
  await langfusePolling?.stop();
  await polling?.stop();
  await app.close();
  await connection.pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
