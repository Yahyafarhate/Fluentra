#!/usr/bin/env bash
# Logical backup of the Fluentra database (custom format, compressed). Run from cron / a scheduler.
#   MIGRATION_DATABASE_URL=postgres://owner:pw@host/db  BACKUP_DIR=./backups  KEEP_DAYS=14  ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
URL="${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required (owner role: backups must bypass row level security)}"
DIR="${BACKUP_DIR:-./backups}"; KEEP="${KEEP_DAYS:-14}"
mkdir -p "$DIR"; chmod 700 "$DIR"
FILE="$DIR/fluentra-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$URL"
chmod 600 "$FILE"
# verify the archive is readable before trusting it
pg_restore --list "$FILE" > /dev/null
find "$DIR" -name 'fluentra-*.dump' -mtime +"$KEEP" -delete
echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
