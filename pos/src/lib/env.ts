/** Central, lazily-evaluated environment access. Secrets only ever come from the environment. */
const bool = (v: string | undefined, d = false) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));

export const env = {
  get isProd() { return process.env.NODE_ENV === "production"; },
  get isTest() { return process.env.NODE_ENV === "test" || !!process.env.VITEST; },
  get databaseUrl() { return process.env.DATABASE_URL ?? "postgres://comptoir_app:comptoir_app@localhost:5432/comptoir"; },
  get appUrl() { return (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, ""); },
  get cronSecret() { return process.env.CRON_SECRET ?? ""; },
  get bcryptCost() { return Number(process.env.BCRYPT_COST ?? (this.isTest ? 4 : 11)); },
  get serverless() { return !!process.env.VERCEL; },
  get testPayments() { return bool(process.env.POS_ENABLE_TEST_PAYMENTS, !this.isProd); },
  get fluentraSecret() { return process.env.FLUENTRA_SHARED_SECRET ?? ""; },
};
