import { describe, expect, it } from "vitest";
import { durationFor, groupTables, segmentHitsRect, largestSingle, pickTables, resolveWindows, slotTimes, validateManualAssignment, type TableLite, type BusyInterval } from "@/server/availability/engine";
import { simulateWait } from "@/server/waitlist/service";
import { canTransition, nextActions } from "@/server/reservations/state";

const T = (id: string, capacity: number, extra: Partial<TableLite> = {}): TableLite => ({ id, name: id, minCapacity: 1, capacity, sectionId: null, floorId: "f", bookableOnline: true, status: "available", active: true, ...extra });
const H = 3600_000;

describe("availability engine", () => {
  it("picks the smallest table that fits", () => {
    const r = pickTables({ tables: [T("a", 6), T("b", 2), T("c", 4)], combos: [], busy: [], start: 0, end: H, party: 3 });
    expect(r).toEqual(["c"]);
  });
  it("skips busy, blocked, inactive and non-online tables", () => {
    const tables = [T("a", 2, { status: "blocked" }), T("b", 2, { active: false }), T("c", 2, { bookableOnline: false }), T("d", 2)];
    const busy: BusyInterval[] = [{ tableId: "d", start: 0, end: H }];
    expect(pickTables({ tables, combos: [], busy, start: H / 2, end: 1.5 * H, party: 2, onlineOnly: true })).toBeNull();
    expect(pickTables({ tables, combos: [], busy, start: H, end: 2 * H, party: 2, onlineOnly: true })).toEqual(["d"]); // back-to-back is not an overlap
    expect(pickTables({ tables, combos: [], busy: [], start: 0, end: H, party: 2, onlineOnly: false })).toEqual(["c"]);
  });
  it("uses a combination only when no single table fits, and only when all members are free", () => {
    const tables = [T("a", 4), T("b", 4)];
    const combos = [{ id: "ab", name: "A+B", minCapacity: 1, capacity: 8, tableIds: ["a", "b"] }];
    expect(pickTables({ tables, combos, busy: [], start: 0, end: H, party: 7 })).toEqual(["a", "b"]);
    expect(pickTables({ tables, combos, busy: [{ tableId: "b", start: 0, end: H }], start: 0, end: H, party: 7 })).toBeNull();
    expect(pickTables({ tables, combos, busy: [], start: 0, end: H, party: 3 })).toHaveLength(1);
  });
  it("respects minimum capacity", () => {
    expect(pickTables({ tables: [T("a", 8, { minCapacity: 5 })], combos: [], busy: [], start: 0, end: H, party: 2 })).toBeNull();
  });
  it("validates manual assignment", () => {
    const tables = [T("a", 2), T("b", 4)];
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["a"], start: 0, end: H, party: 3 })).toBe("INSUFFICIENT_CAPACITY");
    expect(validateManualAssignment({ tables, combos: [], busy: [{ tableId: "b", start: 0, end: H }], tableIds: ["b"], start: 0, end: H, party: 3 })).toBe("TABLE_CONFLICT");
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["a", "b"], start: 0, end: H, party: 3 })).toBe("INCOMPATIBLE_TABLES");
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["zzz"], start: 0, end: H, party: 1 })).toBe("UNKNOWN_TABLE");
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["b"], start: 0, end: H, party: 3 })).toBeNull();
  });
  it("derives durations from rules", () => {
    const rules = [{ maxParty: 2, minutes: 90 }, { maxParty: 6, minutes: 120 }, { maxParty: 999, minutes: 150 }];
    expect([durationFor(rules, 2), durationFor(rules, 5), durationFor(rules, 12)]).toEqual([90, 120, 150]);
  });
  it("resolves service windows with special days", () => {
    const services = [{ id: "s1", name: "Lunch", days: [1, 2, 3], startTime: "12:00", lastSeating: "14:00", slotIntervalMin: null, maxCovers: null, active: true }];
    expect(resolveWindows(services, 1, 30).windows).toHaveLength(1);
    expect(resolveWindows(services, 6, 30).closed).toBe(true);
    expect(resolveWindows(services, 1, 30, { closed: true, label: "Eid", startTime: null, lastSeating: null }).closed).toBe(true);
    const sp = resolveWindows(services, 6, 30, { closed: false, label: "Gala", startTime: "20:00", lastSeating: "21:00" });
    expect(slotTimes(sp.windows[0])).toEqual([1200, 1230, 1260]);
  });
});

describe("reservation state machine", () => {
  it("allows only legal transitions", () => {
    expect(canTransition("pending", "confirm")).toBe(true);
    expect(canTransition("confirmed", "arrive")).toBe(true);
    expect(canTransition("seated", "complete")).toBe(true);
    expect(canTransition("completed", "cancel")).toBe(false);
    expect(canTransition("cancelled", "confirm")).toBe(false);
    expect(canTransition("seated", "cancel")).toBe(false);
    expect(canTransition("confirmed", "complete")).toBe(false);
    expect(nextActions("completed")).toEqual([]);
  });
});

describe("waitlist wait estimation", () => {
  const base = { now: 0, combos: [], bufferMin: 10, durationMin: () => 60 };
  it("is zero when a table is free", () => {
    expect(simulateWait({ ...base, tables: [T("a", 4)], busy: [], ahead: [], party: 2 })).toBe(0);
  });
  it("waits for the occupied table to free up", () => {
    const busy = [{ tableId: "a", start: 0, end: 30 * 60_000 }];
    expect(simulateWait({ ...base, tables: [T("a", 4)], busy, ahead: [], party: 2 })).toBe(30);
  });
  it("accounts for parties ahead in the queue", () => {
    const busy = [{ tableId: "a", start: 0, end: 30 * 60_000 }];
    // one party ahead takes the table at t=30 for 60+10 min
    expect(simulateWait({ ...base, tables: [T("a", 4)], busy, ahead: [2], party: 2 })).toBe(100);
  });
  it("returns null if no table can ever seat the party", () => {
    expect(simulateWait({ ...base, tables: [T("a", 2)], busy: [], ahead: [], party: 8 })).toBeNull();
  });
  it("does not seat a party into a gap that is too short for a reservation that follows", () => {
    const busy = [{ tableId: "a", start: 20 * 60_000, end: 80 * 60_000 }];
    expect(simulateWait({ ...base, tables: [T("a", 4)], busy, ahead: [], party: 2 })).toBe(80);
  });
});

describe("grouping tables for a party bigger than any single table", () => {
  const at = (id: string, capacity: number, x: number, y: number, extra: Partial<TableLite> = {}) => T(id, capacity, { x, y, w: 10, h: 10, ...extra });
  const base = { busy: [] as BusyInterval[], start: 0, end: H };
  it("only groups when the party exceeds the largest table", () => {
    const tables = [at("a", 8, 0, 0), at("b", 4, 20, 0), at("c", 4, 400, 0)];
    expect(largestSingle(tables)).toBe(8);
    expect(pickTables({ tables, combos: [], ...base, party: 8, allowGrouping: true })).toEqual(["a"]);
    expect(pickTables({ tables, combos: [], ...base, party: 12 })).toBeNull();
    expect(pickTables({ tables, combos: [], ...base, party: 12, allowGrouping: true })!.sort()).toEqual(["a", "b"]);
  });
  it("takes the nearest tables, wasting the fewest seats", () => {
    const tables = [at("a", 8, 0, 0), at("far", 4, 500, 500), at("near", 4, 15, 0), at("tiny", 2, 12, 0)];
    expect(groupTables({ tables, ...base, party: 12 })!.sort()).toEqual(["a", "near"]);
    // 10 people: 8 + 2 wastes nothing, even though a 4 is slightly closer
    expect(groupTables({ tables: [at("a", 8, 0, 0), at("four", 4, 12, 0), at("two", 2, 30, 0)], ...base, party: 10 })!.sort()).toEqual(["a", "two"]);
  });
  it("uses any number of tables, skips busy / blocked / other floors, and returns null when nothing fits", () => {
    const tables = [at("a", 4, 0, 0), at("b", 4, 12, 0), at("c", 4, 24, 0), at("d", 4, 36, 0), at("x", 8, 0, 0, { floorId: "other" }), at("z", 4, 48, 0, { status: "blocked" })];
    expect(groupTables({ tables, ...base, party: 16 })!.sort()).toEqual(["a", "b", "c", "d"]);
    expect(groupTables({ tables, busy: [{ tableId: "d", start: 0, end: H }], start: 0, end: H, party: 16 })).toBeNull();
  });
  it("accepts an ad-hoc set of tables for a validator only when asked to", () => {
    const tables = [at("a", 8, 0, 0), at("b", 4, 20, 0)];
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["a", "b"], start: 0, end: H, party: 12 })).toBe("INCOMPATIBLE_TABLES");
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["a", "b"], start: 0, end: H, party: 12, adhoc: true })).toBeNull();
    expect(validateManualAssignment({ tables, combos: [], busy: [], tableIds: ["a", "b"], start: 0, end: H, party: 13, adhoc: true })).toBe("INSUFFICIENT_CAPACITY");
  });
});

describe("obstacles on the floor plan", () => {
  const rect = (o: Partial<{ floorId: string; x: number; y: number; w: number; h: number; rotation: number }> = {}) => ({ floorId: "f", x: 0, y: 0, w: 100, h: 10, rotation: 0, ...o });
  it("detects when a straight line crosses a (rotated) rectangle", () => {
    expect(segmentHitsRect({ x: 50, y: -20 }, { x: 50, y: 30 }, rect())).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 40 }, { x: 100, y: 40 }, rect())).toBe(false);
    expect(segmentHitsRect({ x: 0, y: 5 }, { x: 100, y: 5 }, rect({ rotation: 90 }))).toBe(true);        // now vertical, centred at x=50
    expect(segmentHitsRect({ x: 0, y: 80 }, { x: 100, y: 80 }, rect({ rotation: 90 }))).toBe(false);
    expect(segmentHitsRect({ x: 200, y: 5 }, { x: 300, y: 5 }, rect())).toBe(false);                      // stops short
  });
  it("never groups tables across a pool or wall, and falls back to a group that stays on one side", () => {
    const at = (id: string, capacity: number, x: number) => T(id, capacity, { x, y: 0, w: 10, h: 10 });
    const tables = [at("a", 8, 0), at("b", 4, 100), at("c", 4, 300), at("d", 4, 320)];
    const wall = rect({ x: 50, y: -50, w: 10, h: 200 });                  // between a and everything else
    const args = { tables, busy: [] as BusyInterval[], start: 0, end: H, party: 12 };
    expect(groupTables(args)!.sort()).toEqual(["a", "b"]);
    expect(groupTables({ ...args, obstacles: [wall] })!.sort()).toEqual(["b", "c", "d"]);
    expect(groupTables({ ...args, obstacles: [wall], party: 14 })).toBeNull();                         // 8-seater is cut off, the rest hold 12
    expect(groupTables({ ...args, obstacles: [rect({ floorId: "other", x: 50, y: -50, w: 10, h: 200 })] })!.sort()).toEqual(["a", "b"]); // another floor's wall does not count
  });
});
