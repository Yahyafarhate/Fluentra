/**
 * Pure availability logic — no database access, fully unit-testable.
 * Times are epoch milliseconds. A table interval always includes the preparation buffer.
 */
export interface DurationRule { maxParty: number; minutes: number }
export interface TableLite {
  id: string; name: string; minCapacity: number; capacity: number;
  sectionId: string | null; floorId: string; bookableOnline: boolean;
  status: "available" | "occupied" | "cleaning" | "blocked"; active: boolean;
  /** floor-plan geometry (position of the top-left corner and size), used to group the closest tables */
  x?: number; y?: number; w?: number; h?: number;
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

/** Largest single table that can seat people (the threshold above which a party needs several tables). */
export function largestSingle(tables: TableLite[], onlineOnly?: boolean): number {
  return tables.filter((t) => usable(t, onlineOnly)).reduce((m, t) => Math.max(m, t.capacity), 0);
}

/** Something on the floor plan that people cannot walk through (pool, basin, wall). */
export interface Obstacle { floorId: string; x: number; y: number; w: number; h: number; rotation: number }

/** Does the straight line between two points cross the (possibly rotated) rectangle? Slab test in the rectangle's own frame. */
export function segmentHitsRect(p: { x: number; y: number }, q: { x: number; y: number }, o: Obstacle): boolean {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2, a = (-o.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const loc = (v: { x: number; y: number }) => ({ x: (v.x - cx) * cos - (v.y - cy) * sin, y: (v.x - cx) * sin + (v.y - cy) * cos });
  const a0 = loc(p), b0 = loc(q), hw = o.w / 2, hh = o.h / 2;
  let t0 = 0, t1 = 1;
  const dx = b0.x - a0.x, dy = b0.y - a0.y;
  for (const [d, lo, hi, s] of [[dx, -hw, hw, a0.x], [dy, -hh, hh, a0.y]] as const) {
    if (Math.abs(d) < 1e-9) { if (s < lo || s > hi) return false; continue; }
    let u = (lo - s) / d, v = (hi - s) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}

const centre = (t: TableLite) => ({ x: (t.x ?? 0) + (t.w ?? 0) / 2, y: (t.y ?? 0) + (t.h ?? 0) / 2 });
const dist = (a: TableLite, b: TableLite) => { const p = centre(a), q = centre(b); return Math.hypot(p.x - q.x, p.y - q.y); };

/**
 * Groups free tables of the same floor for a party larger than any single table.
 * Starting from each table, it keeps adding the nearest free table until the party fits, then drops tables that turned out unnecessary.
 * Best group = fewest wasted seats, then fewest tables, then smallest spread. Pure and deterministic.
 */
export function groupTables(a: { tables: TableLite[]; busy: BusyInterval[]; start: number; end: number; party: number; onlineOnly?: boolean; sectionId?: string | null; obstacles?: Obstacle[] }): string[] | null {
  const pool = a.tables.filter((t) => usable(t, a.onlineOnly) && isFree(t.id, a.start, a.end, a.busy) && (!a.sectionId || t.sectionId === a.sectionId));
  const floors = new Set(pool.map((t) => t.floorId));
  // two tables are "linked" when nothing like a pool or a wall stands in the straight line between them
  const linked = (x: TableLite, y: TableLite) => !(a.obstacles ?? []).some((o) => o.floorId === x.floorId && segmentHitsRect(centre(x), centre(y), o));
  const connected = (g: TableLite[]) => { const seen = new Set([g[0].id]); const q = [g[0]]; while (q.length) { const c = q.pop()!; for (const o of g) if (!seen.has(o.id) && linked(c, o)) { seen.add(o.id); q.push(o); } } return seen.size === g.length; };
  let best: { ids: string[]; waste: number; n: number; spread: number } | null = null;
  for (const floor of floors) {
    const tables = pool.filter((t) => t.floorId === floor);
    if (tables.reduce((n, t) => n + t.capacity, 0) < a.party) continue;
    for (const seed of tables) {
      const group = [seed];
      const rest = tables.filter((t) => t.id !== seed.id);
      while (group.reduce((n, t) => n + t.capacity, 0) < a.party && rest.length) {
        const reach = (t: TableLite) => Math.min(...group.filter((g) => linked(g, t)).map((g) => dist(g, t)));
        const open = rest.filter((t) => Number.isFinite(reach(t)));
        if (!open.length) break;
        open.sort((x, y) => reach(x) - reach(y) || y.capacity - x.capacity || x.name.localeCompare(y.name, undefined, { numeric: true }));
        group.push(open[0]); rest.splice(rest.indexOf(open[0]), 1);
      }
      let cap = group.reduce((n, t) => n + t.capacity, 0);
      if (cap < a.party) continue;
      // drop tables that are not needed (farthest from the seed first)
      for (const t of [...group].sort((x, y) => dist(seed, y) - dist(seed, x))) {
        if (t.id === seed.id || cap - t.capacity < a.party) continue;
        const without = group.filter((g) => g !== t);
        if (!connected(without)) continue;
        group.splice(group.indexOf(t), 1); cap -= t.capacity;
      }
      if (!connected(group)) continue;
      let spread = 0;
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) spread += dist(group[i], group[j]);
      const cand = { ids: group.map((t) => t.id).sort(), waste: cap - a.party, n: group.length, spread };
      if (!best || cand.waste < best.waste || (cand.waste === best.waste && (cand.n < best.n || (cand.n === best.n && (cand.spread < best.spread || (cand.spread === best.spread && cand.ids.join() < best.ids.join())))))) best = cand;
    }
  }
  return best ? best.ids : null;
}

export interface PickArgs {
  tables: TableLite[]; combos: ComboLite[]; busy: BusyInterval[];
  start: number; end: number; party: number;
  onlineOnly?: boolean; preferSectionId?: string | null;
  /** strict: only tables of this dining section are considered (guest chose a seating area) */
  onlySectionId?: string | null;
  /** when the party is bigger than every single table, group the nearest free tables */
  allowGrouping?: boolean;
  obstacles?: Obstacle[];
}

const usable = (t: TableLite, onlineOnly?: boolean) => t.active && t.status !== "blocked" && (!onlineOnly || t.bookableOnline);

/** Best-fit table (or compatible combination) for a party. Returns table ids or null. */
export function pickTables(a: PickArgs): string[] | null {
  if (a.onlySectionId) a = { ...a, tables: a.tables.filter((t) => t.sectionId === a.onlySectionId) };
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
  if (combos.length) return [...combos[0].tableIds];
  if (a.allowGrouping && a.party > largestSingle(a.tables, a.onlineOnly)) return groupTables({ tables: a.tables, busy: a.busy, start: a.start, end: a.end, party: a.party, onlineOnly: a.onlineOnly, obstacles: a.obstacles });
  return null;
}

/** Validates that a *specific* table set can host the party for the interval. Returns an error code or null. */
export function validateManualAssignment(a: { tables: TableLite[]; combos: ComboLite[]; busy: BusyInterval[]; tableIds: string[]; start: number; end: number; party: number; adhoc?: boolean }):
  "UNKNOWN_TABLE" | "TABLE_UNAVAILABLE" | "INSUFFICIENT_CAPACITY" | "INCOMPATIBLE_TABLES" | "TABLE_CONFLICT" | null {
  const byId = new Map(a.tables.map((t) => [t.id, t]));
  const chosen = a.tableIds.map((id) => byId.get(id));
  if (!chosen.length || chosen.some((t) => !t)) return "UNKNOWN_TABLE";
  const ts = chosen as TableLite[];
  if (ts.some((t) => !t.active || t.status === "blocked")) return "TABLE_UNAVAILABLE";
  if (ts.length > 1) {
    const set = new Set(a.tableIds);
    const combo = a.combos.find((c) => c.tableIds.length === set.size && c.tableIds.every((id) => set.has(id)));
    if (combo) { if (combo.capacity < a.party) return "INSUFFICIENT_CAPACITY"; }
    else if (!a.adhoc) return "INCOMPATIBLE_TABLES";
    else if (ts.reduce((n, t) => n + t.capacity, 0) < a.party) return "INSUFFICIENT_CAPACITY";
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
