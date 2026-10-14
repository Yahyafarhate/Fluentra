import { describe, it, expect } from "vitest";
import { computeTotals } from "@/server/orders/totals";
import { allocate, roundDiv, bps } from "@/lib/money";

const inc = { pricesIncludeTax: true, serviceChargeBps: 0, serviceChargeTaxBps: 0 };
const item = (id: string, unit: number, qty: number, rate: number, disc = 0) => ({ id, unitPriceCents: unit, qty, taxRateBps: rate, discountCents: disc });

describe("money arithmetic", () => {
  it("rounds half-up on integers and never produces fractions", () => {
    expect(roundDiv(5, 2)).toBe(3); expect(roundDiv(4, 2)).toBe(2); expect(roundDiv(1, 3)).toBe(0); expect(roundDiv(2, 3)).toBe(1);
    expect(bps(1999, 1000)).toBe(200);
  });
  it("allocate always sums to the total (largest remainder)", () => {
    for (const [total, w] of [[100, [1, 1, 1]], [1, [3, 3, 3]], [999, [7, 11, 13, 17]], [0, [5, 5]], [10, [0, 0]]] as Array<[number, number[]]>) {
      const a = allocate(total, w);
      expect(a.every(Number.isInteger)).toBe(true);
      if (w.some((x) => x > 0)) expect(a.reduce((x, y) => x + y, 0)).toBe(total);
    }
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
});

describe("bill totals", () => {
  it("tax-inclusive: total is the sum of the lines and tax is carved out per rate", () => {
    const t = computeTotals([item("a", 11000, 1, 1000), item("b", 12000, 1, 2000)], [], inc);
    expect(t.totalCents).toBe(23000);
    expect(t.taxLines).toEqual([
      { rateBps: 1000, baseCents: 10000, taxCents: 1000, grossCents: 11000 },
      { rateBps: 2000, baseCents: 10000, taxCents: 2000, grossCents: 12000 },
    ]);
    expect(t.taxCents).toBe(3000); expect(t.netSalesCents).toBe(20000);
  });
  it("tax-exclusive adds tax on top", () => {
    const t = computeTotals([item("a", 10000, 2, 1000)], [], { ...inc, pricesIncludeTax: false });
    expect(t.taxCents).toBe(2000); expect(t.totalCents).toBe(22000); expect(t.netSalesCents).toBe(20000);
  });
  it("item discount, then percent order discount, then service charge — in that order", () => {
    const t = computeTotals([item("a", 10000, 1, 1000, 1000), item("b", 10000, 1, 1000)], [{ kind: "percent", value: 1000 }], { pricesIncludeTax: true, serviceChargeBps: 1000, serviceChargeTaxBps: 1000 });
    // lines: 9000 + 10000 = 19000; 10% off = 1900 → 17100; service 10% = 1710 → total 18810
    expect(t.grossCents).toBe(20000); expect(t.itemDiscountCents).toBe(1000); expect(t.orderDiscountCents).toBe(1900);
    expect(t.discountedCents).toBe(17100); expect(t.serviceChargeCents).toBe(1710); expect(t.totalCents).toBe(18810);
    expect(t.taxCents).toBe(Math.round((18810 * 1000) / 11000));
  });
  it("a discount can never exceed the bill and the bill never goes negative", () => {
    const t = computeTotals([item("a", 5000, 1, 1000)], [{ kind: "amount", value: 999999 }, { kind: "percent", value: 5000 }], inc);
    expect(t.orderDiscountCents).toBe(5000); expect(t.totalCents).toBe(0); expect(t.taxCents).toBe(0);
  });
  it("order discount is spread over lines so per-rate tax stays consistent", () => {
    const t = computeTotals([item("a", 10000, 1, 1000), item("b", 10000, 1, 2000)], [{ kind: "amount", value: 3001 }], inc);
    expect(t.discountedCents).toBe(16999);
    expect(t.taxLines.reduce((s, l) => s + l.grossCents, 0)).toBe(16999);
  });
});
