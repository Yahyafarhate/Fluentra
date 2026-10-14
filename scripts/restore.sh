#!/usr/bin/env bash
# Restore a backup into a (new, empty) database:   ./scripts/restore.sh backups/fluentra-….dump postgres://owner:pw@host/new_db
# Then run `npm run db:migrate` so the runtime role gets its grants. Never restore over a live production database.
set -euo pipefail
FILE="${1:?usage: restore.sh <dump-file> <target-database-url>}"; TARGET="${2:?target database url required}"
read -r -p "Restore $FILE into the database in the given URL? Existing objects with the same names will be replaced. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo aborted; exit 1; }
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" "$FILE"
echo "restore finished — now run: MIGRATION_DATABASE_URL=\"$TARGET\" npm run db:migrate"
