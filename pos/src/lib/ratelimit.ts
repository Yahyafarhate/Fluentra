import { withSystem } from "./db";
import { tooMany } from "./errors";

/** Fixed-window limiter stored in Postgres (shared across instances). Throws 429 when exceeded. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<void> {
  const row = await withSystem((db) =>
    db.one<{ hits: number; windowStart: Date }>(
      `INSERT INTO rate_limits (key, window_start, hits)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
       RETURNING hits, window_start`,
      [key, windowSec],
    ),
  );
  if (row.hits > limit) {
    const retry = Math.max(1, Math.ceil((row.windowStart.getTime() + windowSec * 1000 - Date.now()) / 1000));
    throw tooMany(retry);
  }
}

export async function purgeRateLimits() {
  await withSystem((db) => db.exec(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`));
}

export function clientIp(req: Request): string {
  if (process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1") {
    const xf = req.headers.get("x-forwarded-for");
    if (xf) return xf.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip") ?? "local";
}
