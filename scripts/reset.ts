import { loadEnv } from "./load-env";
import { dropEverything, runMigrations } from "./migrate";
loadEnv();

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("db:reset is disabled in production");
  const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://fluentra:fluentra@localhost:5432/fluentra";
  await dropEverything(url);
  await runMigrations({ url });
  if (!process.argv.includes("--no-seed")) {
    const { seed } = await import("./seed");
    await seed();
  }
  console.log("database reset" + (process.argv.includes("--no-seed") ? "" : " and seeded with demo data"));
}
main().catch((e) => { console.error(e); process.exit(1); });
