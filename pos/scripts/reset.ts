import { loadEnv } from "./load-env";
import { dropEverything, runMigrations } from "./migrate";

loadEnv();
(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
  const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://fluentra:fluentra@localhost:5432/comptoir";
  await dropEverything(url);
  await runMigrations({ url });
  const { seed } = await import("./seed");
  await seed();
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
