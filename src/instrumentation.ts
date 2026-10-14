/** Starts the in-process job runner in development (JOB_RUNNER_INLINE=true). Production should use a scheduler or `npm run worker`. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.JOB_RUNNER_INLINE !== "true") return;
  const g = globalThis as unknown as { __flRunner?: NodeJS.Timeout };
  if (g.__flRunner) return;
  const { scheduleTick } = await import("@/server/automation/service");
  const { runDueJobs } = await import("@/server/notifications/jobs");
  const { log } = await import("@/lib/logger");
  g.__flRunner = setInterval(async () => {
    try { await scheduleTick(); await runDueJobs(25); } catch (e) { log.error("inline job runner error", { error: String(e) }); }
  }, 15_000);
  log.info("inline job runner started (development)");
}
