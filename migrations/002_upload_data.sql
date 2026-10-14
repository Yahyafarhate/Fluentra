-- Allow storing image bytes in the database (used on hosts without a persistent disk, e.g. Vercel).
ALTER TABLE uploads ADD COLUMN data bytea;
ALTER TABLE uploads ALTER COLUMN storage_key DROP NOT NULL;
