import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabaseConnection, waitForPostgres } from "./db/client.js";
import {
  ConsentDeletionWorker,
  startConsentDeletionPolling,
} from "./jobs/consent-deletion.js";
import {
  RetentionPurgeJob,
  startDailyRetention,
} from "./jobs/retention.js";
import { OutboxWorker, startOutboxPolling } from "./outbox/worker.js";
import {
  PrivacyDeletionWorker,
  startPrivacyDeletionPolling,
} from "./privacy/erasure.js";
import { createTelemetrySinks } from "./sinks/telemetry-sinks.js";
import { SystemClock } from "./telemetry/clock.js";
import { loadEventCatalogRegistry } from "./telemetry/event-catalog.js";

const config = loadConfig();
const connection = createDatabaseConnection(config.databaseUrl);
const catalogs = loadEventCatalogRegistry();
const catalog = catalogs.current;
const app = buildApp(config, { connection, catalog });
const sinks = createTelemetrySinks(config);
const clock = new SystemClock();
const worker = new OutboxWorker({
  pool: connection.pool,
  catalogs,
  clock,
  posthog: sinks.posthog,
  otel: sinks.otel,
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
});
const consentDeletionWorker = new ConsentDeletionWorker({
  pool: connection.pool,
  catalog,
  clock,
});
let polling: ReturnType<typeof startOutboxPolling> | undefined;
let consentDeletionPolling:
  | ReturnType<typeof startConsentDeletionPolling>
  | undefined;
let privacyDeletionPolling:
  | ReturnType<typeof startPrivacyDeletionPolling>
  | undefined;
let retentionSchedule: ReturnType<typeof startDailyRetention> | undefined;

try {
  await waitForPostgres(connection.pool);
  await app.listen({ host: config.host, port: config.port });
  polling = startOutboxPolling(worker, config.outboxPollIntervalMs, () => {
    console.error("Telemetry outbox worker cycle failed.");
  });
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
} catch (_error) {
  console.error("Learning-signal service failed to start.");
  await connection.pool.end();
  process.exitCode = 1;
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await retentionSchedule?.stop();
  await consentDeletionPolling?.stop();
  await privacyDeletionPolling?.stop();
  await polling?.stop();
  await app.close();
  await connection.pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
