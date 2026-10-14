import type { Db } from "./db";

/**
 * PostgreSQL is the single source of truth for time-zone conversions.
 * (The Node runtime ships its own tz database; when the two disagree — it happens whenever a government changes
 * DST rules — local times computed in two places would drift. Every wall-clock <-> UTC conversion goes through here.)
 */
export async function localToUtc(db: Db, date: string, time: string, tz: string): Promise<Date> {
  const r = await db.one<{ t: Date }>(`SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t`, [date, time.slice(0, 5), tz]);
  return r.t;
}

export async function utcToLocal(db: Db, instant: Date, tz: string): Promise<{ date: string; time: string }> {
  return db.one<{ date: string; time: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS date, to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS time`, [instant, tz]);
}

export async function todayLocal(db: Db, tz: string, now = new Date()): Promise<string> {
  return (await utcToLocal(db, now, tz)).date;
}

export async function localDayBounds(db: Db, date: string, tz: string): Promise<[Date, Date]> {
  const r = await db.one<{ s: Date; e: Date }>(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS s, (($1::date + 1)::timestamp AT TIME ZONE $2) AS e`, [date, tz]);
  return [r.s, r.e];
}

/** Local offset in minutes (local = UTC + offset) used for the given local date at noon. */
export async function noonOffsetMin(db: Db, date: string, tz: string): Promise<number> {
  const noon = await localToUtc(db, date, "12:00", tz);
  const [y, m, d] = date.split("-").map(Number);
  return 720 - (noon.getTime() - Date.UTC(y, m - 1, d)) / 60000;
}

export async function assertKnownZone(db: Db, tz: string) {
  const ok = await db.maybe(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz]);
  if (!ok) throw new Error(`Time zone "${tz}" is not known to the database`);
}
