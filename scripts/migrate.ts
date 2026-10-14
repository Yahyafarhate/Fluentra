import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env";

const dir = path.resolve(process.cwd(), "migrations");

/** Applies pending SQL migrations as the schema OWNER, then (re)grants runtime privileges to the app role. */
export async function runMigrations(opts: { url?: string; appRole?: string; appPassword?: string; log?: boolean } = {}) {
  const rawUrl = opts.url ?? process.env.MIGRATION_DATABASE_URL ?? "postgres://fluentra:fluentra@localhost:5432/fluentra";
  // `pg` does not implement channel binding (Neon URLs often carry channel_binding=require): drop it.
  const url = rawUrl.replace(/([?&])channel_binding=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const appRole = opts.appRole ?? "fluentra_app";
  const appPassword = opts.appPassword ?? process.env.APP_DB_PASSWORD ?? "fluentra_app";
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        if (opts.log !== false) console.log(`applied ${f}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    // Runtime role: NOT a superuser, NOT the owner -> Row Level Security always applies to it.
    const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [appRole])).rowCount;
    const pw = appPassword.replace(/'/g, "''");
    if (!exists) await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    else await client.query(`ALTER ROLE ${appRole} PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
    const db = (await client.query("SELECT current_database() AS d")).rows[0].d;
    await client.query(`GRANT CONNECT ON DATABASE "${db}" TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
    await client.query(`REVOKE UPDATE, DELETE ON audit_logs, consents FROM ${appRole}`); // append-only ledgers
    await client.query(`REVOKE ALL ON schema_migrations FROM ${appRole}`);
  } finally {
    await client.end();
  }
}

/** Dev/test only: wipes the public schema. Refuses to run against production. */
export async function dropEverything(url: string) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally { await client.end(); }
}

const invokedDirectly = process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  loadEnv();
  runMigrations().then(() => console.log("migrations up to date")).catch((e) => { console.error(e.message); process.exit(1); });
}
