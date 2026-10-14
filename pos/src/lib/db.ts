import { Pool, types, type PoolClient } from "pg";
import { env } from "./env";
import { log } from "./logger";

// DATE as plain string (no timezone shifts), NUMERIC/INT8 as numbers.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => Number(v));

const g = globalThis as unknown as { __flPool?: Pool };
export function getPool(): Pool {
  if (!g.__flPool) {
    g.__flPool = new Pool({ connectionString: env.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? (process.env.VERCEL ? 3 : 20)), idleTimeoutMillis: 30_000 });
    g.__flPool.on("error", (e) => log.error("pg pool error", { error: e.message }));
  }
  return g.__flPool;
}
export async function closePool() {
  if (g.__flPool) { await g.__flPool.end(); g.__flPool = undefined; }
}

 
export type Row = Record<string, any>;

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
function camelizeRow(r: Row): Row {
  const o: Row = {};
  for (const k of Object.keys(r)) o[camel(k)] = r[k];
  return o;
}

export interface Db {
  /** Run a query, returning rows with camelCased column names. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T>;
  maybe<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
  /** Register a callback that runs only after the surrounding transaction commits. */
  afterCommit(fn: () => void | Promise<void>): void;
  readonly client: PoolClient;
}

export type Scope = { orgId: string } | { system: true };

function wrap(client: PoolClient, hooks: Array<() => void | Promise<void>>): Db {
  const query = async <T,>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows.map(camelizeRow) as T[];
  return {
    client,
    query,
    async one<T = Row>(sql: string, params?: unknown[]) {
      const rows = await query<T>(sql, params);
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
    async maybe<T = Row>(sql: string, params?: unknown[]) {
      return (await query<T>(sql, params))[0] ?? null;
    },
    async exec(sql, params) {
      return (await client.query(sql, params)).rowCount ?? 0;
    },
    afterCommit(fn) { hooks.push(fn); },
  };
}

const RETRYABLE = new Set(["40001", "40P01"]);

/**
 * Run `fn` inside a transaction with the tenant scope applied via transaction-local settings.
 * The scope drives PostgreSQL Row Level Security: with `{orgId}` only that organization's rows are visible
 * and writable. `{system: true}` must be used deliberately (auth, public lookups, jobs, super-admin).
 */
export async function withScope<T>(scope: Scope, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    const hooks: Array<() => void | Promise<void>> = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.system', $2, true)", [
        "orgId" in scope ? scope.orgId : "",
        "system" in scope ? "on" : "",
      ]);
      const result = await fn(wrap(client, hooks));
      await client.query("COMMIT");
      client.release();
      for (const h of hooks) { try { await h(); } catch (e) { log.error("afterCommit hook failed", { error: String(e) }); } }
      return result;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      client.release();
      const code = (e as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 3) continue;
      throw e;
    }
  }
}

export const withOrg = <T,>(orgId: string, fn: (db: Db) => Promise<T>) => withScope({ orgId }, fn);
export const withSystem = <T,>(fn: (db: Db) => Promise<T>) => withScope({ system: true }, fn);

/** Emit a change event on the realtime channel (delivered on commit). */
export async function notifyChange(db: Db, orgId: string, outletId: string | null, kind: string) {
  await db.exec("SELECT pg_notify('pos_changes', $1)", [JSON.stringify({ orgId, outletId, kind, at: Date.now() })]);
}
