import { loadConfig } from "../config.js";
import { createDatabaseConnection, waitForPostgres } from "../db/client.js";
import { BudgetGuardrail } from "./budget.js";
import { MetricsRunner } from "./metrics-runner.js";

// Cron entrypoint for the daily metrics jobs. Run with no argument to process
// the previous complete UTC day, or pass a single YYYY-MM-DD to (re)build a
// specific date; both are idempotent. Example crontab (05:10 UTC daily):
//   10 5 * * * cd /srv/learning-signals && \
//     node --import tsx src/jobs/metrics-cli.ts >> /var/log/metrics.log 2>&1
async function main(): Promise<void> {
  const config = loadConfig();
  const connection = createDatabaseConnection(config.databaseUrl);
  try {
    await waitForPostgres(connection.pool);
    const runner = new MetricsRunner({ pool: connection.pool });
    const budget = new BudgetGuardrail({ pool: connection.pool });
    const requestedDate = process.argv[2];
    const summary = requestedDate
      ? await runner.runDay(requestedDate)
      : await runner.runOnce();
    const budgetResult = requestedDate
      ? await budget.evaluateDay(requestedDate)
      : await budget.runOnce();
    // Operational counts only; never event content.
    console.log(
      `metrics run ${summary.runId} for ${summary.metricDate}: ` +
        `${summary.snapshotCount} snapshots, ${summary.alertCount} alerts, ` +
        `${budgetResult.alertCount} budget alerts`,
    );
  } finally {
    await connection.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Daily metrics run failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
});
