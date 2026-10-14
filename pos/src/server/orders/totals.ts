import { allocate, bps, roundDiv } from "@/lib/money";

export interface TotalsItem { id: string; unitPriceCents: number; qty: number; taxRateBps: number; discountCents: number }
export interface TotalsDiscount { kind: "percent" | "amount"; value: number }
export interface TotalsConfig { pricesIncludeTax: boolean; serviceChargeBps: number; serviceChargeTaxBps: number }
export interface TaxLine { rateBps: number; baseCents: number; taxCents: number; grossCents: number }
export interface Totals {
  grossCents: number;            // sum of qty × unit price, before any discount
  itemDiscountCents: number;
  orderDiscountCents: number;
  discountedCents: number;       // items after all discounts (tax-inclusive when prices include tax)
  serviceChargeCents: number;
  taxCents: number;
  totalCents: number;            // what the guest owes (tips excluded)
  netSalesCents: number;         // items after discounts, excluding tax and service charge
  taxLines: TaxLine[];
}

/**
 * Pure bill computation. Order of operations (documented in docs/METRICS.md):
 *  1. line = qty × unit price − item discount
 *  2. order-level discounts apply sequentially to the running base and are spread over lines by largest remainder
 *  3. service charge = % of the discounted items
 *  4. tax per rate group (inclusive: tax = gross × r / (1+r); exclusive: tax = base × r)
 */
export function computeTotals(items: TotalsItem[], discounts: TotalsDiscount[], cfg: TotalsConfig): Totals {
  const lines = items.map((it) => {
    const gross = it.unitPriceCents * it.qty;
    const itemDisc = Math.min(it.discountCents, gross);
    return { it, gross, itemDisc, net: gross - itemDisc };
  });
  const grossCents = lines.reduce((a, l) => a + l.gross, 0);
  const itemDiscountCents = lines.reduce((a, l) => a + l.itemDisc, 0);
  let base = grossCents - itemDiscountCents;
  let orderDiscountCents = 0;
  for (const d of discounts) {
    const amt = Math.min(base, d.kind === "percent" ? bps(base, d.value) : d.value);
    orderDiscountCents += amt;
    base -= amt;
  }
  const alloc = allocate(orderDiscountCents, lines.map((l) => l.net));
  const after = lines.map((l, i) => ({ rate: l.it.taxRateBps, amount: l.net - alloc[i] }));
  const discountedCents = after.reduce((a, l) => a + l.amount, 0);
  const serviceChargeCents = bps(discountedCents, cfg.serviceChargeBps);

  const groups = new Map<number, number>();
  for (const l of after) groups.set(l.rate, (groups.get(l.rate) ?? 0) + l.amount);
  if (serviceChargeCents > 0 && !groups.has(cfg.serviceChargeTaxBps)) groups.set(cfg.serviceChargeTaxBps, 0);
  const scRate = cfg.serviceChargeTaxBps;
  const taxLines: TaxLine[] = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rateBps, itemsGross]) => {
    const gross = itemsGross + (rateBps === scRate ? serviceChargeCents : 0);
    if (cfg.pricesIncludeTax) {
      const tax = roundDiv(gross * rateBps, 10000 + rateBps);
      return { rateBps, baseCents: gross - tax, taxCents: tax, grossCents: gross };
    }
    const tax = bps(gross, rateBps);
    return { rateBps, baseCents: gross, taxCents: tax, grossCents: gross + tax };
  }).filter((l) => l.grossCents > 0 || l.taxCents > 0);

  const taxCents = taxLines.reduce((a, l) => a + l.taxCents, 0);
  const totalCents = cfg.pricesIncludeTax ? discountedCents + serviceChargeCents : discountedCents + serviceChargeCents + taxCents;
  const itemTax = (() => {
    // tax that belongs to items only (service charge tax excluded), for net sales
    let t = 0;
    for (const [rate, amount] of groups) {
      if (cfg.pricesIncludeTax) t += roundDiv(amount * rate, 10000 + rate);
      else t += bps(amount, rate);
    }
    return cfg.pricesIncludeTax ? t : 0;
  })();
  const netSalesCents = cfg.pricesIncludeTax ? discountedCents - itemTax : discountedCents;
  return { grossCents, itemDiscountCents, orderDiscountCents, discountedCents, serviceChargeCents, taxCents, totalCents, netSalesCents, taxLines };
}
