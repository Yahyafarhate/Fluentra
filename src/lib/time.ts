import { DateTime } from "luxon";

export const isDateStr = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
export const isTimeStr = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);
export const hhmm = (s: string) => s.slice(0, 5);
export const timeToMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
export const minToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** ISO weekday 1..7 for a calendar date string. */
export const isoWeekday = (date: string) => DateTime.fromISO(date, { zone: "utc" }).weekday;
export const addDays = (date: string, n: number) => DateTime.fromISO(date, { zone: "utc" }).plus({ days: n }).toISODate()!;
export const daysBetween = (a: string, b: string) => Math.round(DateTime.fromISO(b, { zone: "utc" }).diff(DateTime.fromISO(a, { zone: "utc" }), "days").days);
export const isValidZone = (tz: string) => DateTime.local().setZone(tz).isValid;
