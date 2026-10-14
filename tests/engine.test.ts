import { describe, expect, it } from "vitest";
import { durationFor, pickTables, resolveWindows, slotTimes, validateManualAssignment, type TableLite, type BusyInterval } from "@/server/availability/engine";
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
