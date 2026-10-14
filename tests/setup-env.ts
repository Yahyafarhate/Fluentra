process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://fluentra_app:fluentra_app@localhost:5432/fluentra_test";
process.env.BCRYPT_COST = "4";
process.env.DEV_SIMULATE_NOTIFICATIONS = "true";
process.env.APP_URL = "http://localhost:3000";
process.env.APP_SECRET = "test-secret-test-secret-test-secret-test";
delete process.env.SMTP_HOST;
