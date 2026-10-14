/**
 * Pure availability logic — no database access, fully unit-testable.
 * Times are epoch milliseconds. A table interval always includes the preparation buffer.
 */
export interface DurationRule { maxParty: number; minutes: number }
export interface TableLite {
  id: string; name: string; minCapacity: number; capacity: number;
  sectionId: string | null; floorId: string; bookableOnline: boolean;
  status: "available" | "occupied" | "cleaning" | "blocked"; active: boolean;
}
export interface ComboLite { id: string; name: string; minCapacity: number; capacity: number; tableIds: string[] }
export interface BusyInterval { tableId: string; start: number; end: number }

export function durationFor(rules: DurationRule[], party: number): number {
  const sorted = [...rules].sort((a, b) => a.maxParty - b.maxParty);
  for (const r of sorted) if (party <= r.maxParty) return r.minutes;
  return sorted.length ? sorted[sorted.length - 1].minutes : 120;
}

export const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

export function isFree(tableId: string, start: number, end: number, busy: BusyInterval[]): boolean {
  for (const b of busy) if (b.tableId === tableId && overlaps(start, end, b.start, b.end)) return false;
  return true;
}

export interface PickArgs {
  tables: TableLite[]; combos: ComboLite[]; busy: BusyInterval[];
  start: number; end: number; party: number;
  onlineOnly?: boolean; preferSectionId?: string | null;
}

const usable = (t: TableLite, onlineOnly?: boolean) => t.active && t.status !== "blocked" && (!onlineOnly || t.bookableOnline);

/** Best-fit table (or compatible combination) for a party. Returns table ids or null. */
export function pickTables(a: PickArgs): string[] | null {
  const byId = new Map(a.tables.map((t) => [t.id, t]));
  const singles = a.tables
    .filter((t) => usable(t, a.onlineOnly) && t.capacity >= a.party && t.minCapacity <= a.party && isFree(t.id, a.start, a.end, a.busy))
    .sort((x, y) =>
      (x.capacity - a.party) - (y.capacity - a.party) ||
      Number(y.sectionId === a.preferSectionId) - Number(x.sectionId === a.preferSectionId) ||
      x.name.localeCompare(y.name, undefined, { numeric: true }));
  if (singles.length) return [singles[0].id];

  const combos = a.combos
    .filter((c) => c.capacity >= a.party && c.minCapacity <= a.party &&
      c.tableIds.every((id) => { const t = byId.get(id); return !!t && usable(t, a.onlineOnly) && isFree(id, a.start, a.end, a.busy); }))
    .sort((x, y) => (x.capacity - a.party) - (y.capacity - a.party) || x.name.localeCompare(y.name, undefined, { numeric: true }));
  return combos.length ? [...combos[0].tableIds] : null;
}

/** Validates that a *specific* table set can host the party for the interval. Returns an error code or null. */
export function validateManualAssignment(a: { tables: TableLite[]; combos: ComboLite[]; busy: BusyInterval[]; tableIds: string[]; start: number; end: number; party: number }):
  "UNKNOWN_TABLE" | "TABLE_UNAVAILABLE" | "INSUFFICIENT_CAPACITY" | "INCOMPATIBLE_TABLES" | "TABLE_CONFLICT" | null {
  const byId = new Map(a.tables.map((t) => [t.id, t]));
  const chosen = a.tableIds.map((id) => byId.get(id));
  if (!chosen.length || chosen.some((t) => !t)) return "UNKNOWN_TABLE";
  const ts = chosen as TableLite[];
  if (ts.some((t) => !t.active || t.status === "blocked")) return "TABLE_UNAVAILABLE";
  if (ts.length > 1) {
    const set = new Set(a.tableIds);
    const combo = a.combos.find((c) => c.tableIds.length === set.size && c.tableIds.every((id) => set.has(id)));
    if (!combo) return "INCOMPATIBLE_TABLES";
    if (combo.capacity < a.party) return "INSUFFICIENT_CAPACITY";
  } else if (ts[0].capacity < a.party) return "INSUFFICIENT_CAPACITY";
  if (ts.some((t) => !isFree(t.id, a.start, a.end, a.busy))) return "TABLE_CONFLICT";
  return null;
}

export interface ServiceWindow {
  serviceId: string | null; name: string; startMin: number; lastSeatingMin: number;
  intervalMin: number; maxCovers: number | null;
}

export function slotTimes(w: ServiceWindow): number[] {
  const out: number[] = [];
  for (let m = w.startMin; m <= w.lastSeatingMin; m += w.intervalMin) out.push(m);
  return out;
}

export interface ServiceRow { id: string; name: string; days: number[]; startTime: string; lastSeating: string; slotIntervalMin: number | null; maxCovers: number | null; active: boolean }
export interface SpecialDayRow { closed: boolean; label: string | null; startTime: string | null; lastSeating: string | null }

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

/** Which service windows are bookable on a given ISO weekday, honouring special days. */
export function resolveWindows(services: ServiceRow[], weekday: number, defaultInterval: number, special?: SpecialDayRow | null):
  { closed: boolean; label: string | null; windows: ServiceWindow[] } {
  if (special?.closed) return { closed: true, label: special.label, windows: [] };
  if (special && special.startTime && special.lastSeating) {
    return { closed: false, label: special.label, windows: [{ serviceId: null, name: special.label ?? "Special", startMin: toMin(special.startTime), lastSeatingMin: toMin(special.lastSeating), intervalMin: defaultInterval, maxCovers: null }] };
  }
  const windows = services.filter((s) => s.active && s.days.includes(weekday)).sort((a, b) => toMin(a.startTime) - toMin(b.startTime)).map((s) => ({
    serviceId: s.id, name: s.name, startMin: toMin(s.startTime), lastSeatingMin: toMin(s.lastSeating),
    intervalMin: s.slotIntervalMin ?? defaultInterval, maxCovers: s.maxCovers,
  }));
  return { closed: windows.length === 0, label: null, windows };
}
