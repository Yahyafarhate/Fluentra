import { dropEverything, runMigrations } from "../scripts/migrate";

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? "postgres://fluentra:fluentra@localhost:5432/fluentra_test";

export default async function setup() {
  await dropEverything(OWNER_URL);
  await runMigrations({ url: OWNER_URL, log: false });
}
