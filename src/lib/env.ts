/** Central, lazily-evaluated environment access. Secrets only ever come from the environment. */
const bool = (v: string | undefined, d = false) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));

export const env = {
  get nodeEnv() { return process.env.NODE_ENV ?? "development"; },
  get isProd() { return process.env.NODE_ENV === "production"; },
  get isTest() { return process.env.NODE_ENV === "test" || !!process.env.VITEST; },
  get databaseUrl() { return process.env.DATABASE_URL ?? "postgres://fluentra_app:fluentra_app@localhost:5432/fluentra"; },
  get migrationDatabaseUrl() { return process.env.MIGRATION_DATABASE_URL ?? "postgres://fluentra:fluentra@localhost:5432/fluentra"; },
  get appDbPassword() { return process.env.APP_DB_PASSWORD ?? "fluentra_app"; },
  get appUrl() { return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""); },
  get appSecret() { return process.env.APP_SECRET ?? "dev-only-secret-dev-only-secret-dev-only"; },
  get cronSecret() { return process.env.CRON_SECRET ?? ""; },
  get webhookSecret() { return process.env.WEBHOOK_SECRET ?? ""; },
  get simulateNotifications() { return bool(process.env.DEV_SIMULATE_NOTIFICATIONS, !this.isProd); },
  get jobRunnerInline() { return bool(process.env.JOB_RUNNER_INLINE, false); },
  get bcryptCost() { return Number(process.env.BCRYPT_COST ?? (this.isTest ? 4 : 12)); },
  get trustProxy() { return bool(process.env.TRUST_PROXY, false); },
  /** "db" stores images in PostgreSQL (needed on Vercel: no persistent disk); "disk" uses UPLOAD_DIR. */
  get storageDriver(): "db" | "disk" { const v = process.env.STORAGE_DRIVER; return v === "db" || v === "disk" ? v : process.env.VERCEL ? "db" : "disk"; },
  get serverless() { return !!process.env.VERCEL; },
  get uploadDir() { return process.env.UPLOAD_DIR ?? "./uploads"; },
  get smtp() {
    const host = process.env.SMTP_HOST;
    if (!host) return null;
    return { host, port: Number(process.env.SMTP_PORT ?? 587), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.SMTP_FROM ?? "Fluentra <no-reply@example.com>" };
  },
  get twilioConfigured() { return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN); },
  get whatsappConfigured() { return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID); },
  get stripeConfigured() { return !!process.env.STRIPE_SECRET_KEY; },
};
