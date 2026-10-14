import type { Db } from "@/lib/db";
import { conflict } from "@/lib/errors";

/**
 * Runs `fn` at most once per (org, scope, key). Must be called inside the same transaction as the work:
 * if the work rolls back, the key rolls back too, so a retry re-executes; if it commits, retries get the stored response.
 * A concurrent duplicate blocks on the unique index until the first commits, then replays its response.
 */
export async function idempotent<T>(db: Db, orgId: string, scope: string, key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const ins = await db.maybe(`INSERT INTO idempotency_keys (org_id, key, scope) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key`, [orgId, key, scope]);
  if (!ins) {
    const r = await db.maybe<{ response: T | null }>(`SELECT response FROM idempotency_keys WHERE org_id = $1 AND scope = $2 AND key = $3`, [orgId, scope, key]);
    if (r?.response !== null && r?.response !== undefined) return r.response;
    throw conflict("A request with this idempotency key is still in progress", "IDEMPOTENCY_IN_PROGRESS");
  }
  const out = await fn();
  await db.exec(`UPDATE idempotency_keys SET response = $4 WHERE org_id = $1 AND scope = $2 AND key = $3`, [orgId, scope, key, JSON.stringify(out ?? null)]);
  return out;
}
