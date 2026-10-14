process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://comptoir_app:comptoir_app@localhost:5432/comptoir_test";
process.env.BCRYPT_COST = "4";
process.env.APP_URL = "http://localhost:3100";
process.env.POS_ENABLE_TEST_PAYMENTS = "true";
process.env.CRON_SECRET = "test-cron-secret";
process.env.FLUENTRA_SHARED_SECRET = "test-fluentra-secret";
