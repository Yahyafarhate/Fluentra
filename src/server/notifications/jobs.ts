import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/logger";

export type JobHandler = (payload: Record<string, any>) => Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
const handlers = new Map<string, JobHandler>();
export const registerJob = (type: string, h: JobHandler) => { handlers.set(type, h); };

export async function enqueueJob(db: Db, type: string, payload: Record<string, unknown>, opts: { runAt?: Date; idempotencyKey?: string; maxAttempts?: number } = {}) {
  await db.exec(
    `INSERT INTO jobs (org_id, type, payload, run_at, idempotency_key, max_attempts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
    [(payload.orgId as string | undefined) ?? null, type, JSON.stringify(payload), opts.runAt ?? new Date(), opts.idempotencyKey ?? null, opts.maxAttempts ?? 5]);
}

/** Claims due jobs with SKIP LOCKED (safe with several workers), runs them, applies exponential backoff on failure. */
export async function runDueJobs(limit = 25): Promise<{ ran: number; failed: number }> {
  await import("./register"); // ensure handlers are registered
  const claimed = await withSystem((db) =>
    db.query<{ id: number; type: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number }>(
      `UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1
        WHERE id IN (SELECT id FROM jobs WHERE (status='queued' AND run_at <= now()) OR (status='running' AND locked_at < now() - interval '10 minutes')
                      ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, attempts, max_attempts`, [limit]));
  let failed = 0;
  for (const job of claimed) {
    try {
      const h = handlers.get(job.type);
      if (!h) throw new Error(`No handler for job type ${job.type}`);
      await h(job.payload);
      await withSystem((db) => db.exec(`UPDATE jobs SET status='done', finished_at=now(), last_error=NULL WHERE id=$1`, [job.id]));
    } catch (e) {
      failed++;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      log.error("job failed", { type: job.type, id: job.id, attempt: job.attempts, error: msg });
      await withSystem((db) =>
        job.attempts >= job.maxAttempts
          ? db.exec(`UPDATE jobs SET status='failed', finished_at=now(), last_error=$2 WHERE id=$1`, [job.id, msg])
          : db.exec(`UPDATE jobs SET status='queued', locked_at=NULL, last_error=$2, run_at = now() + make_interval(secs => $3) WHERE id=$1`,
              [job.id, msg, Math.min(3600, 30 * 2 ** (job.attempts - 1))]));
    }
  }
  return { ran: claimed.length, failed };
}

export async function jobStats() {
  return withSystem((db) => db.one<{ queued: number; failed: number; running: number; oldestQueuedAgeSec: number | null }>(
    `SELECT count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='failed')::int AS failed,
            count(*) FILTER (WHERE status='running')::int AS running,
            extract(epoch FROM now() - min(run_at) FILTER (WHERE status='queued' AND run_at <= now()))::int AS oldest_queued_age_sec FROM jobs`));
}
