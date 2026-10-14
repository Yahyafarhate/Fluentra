/**
 * Money is ALWAYS an integer number of minor units (centimes). No floating point is used for amounts:
 * every division goes through `roundDiv` (half-up on integers) and splits go through `allocate`
 * (largest-remainder), so parts always add up to the whole.
 */
export function roundDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) throw new Error("roundDiv: integer inputs required");
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** basis points of an amount, rounded half-up */
export const bps = (amount: number, rateBps: number) => roundDiv(amount * rateBps, 10000);

/** Split `total` across `weights` proportionally; the result always sums exactly to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, frac: (total * w) % sum }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) base[order[k].i]++;
  return base;
}

export function formatMoney(cents: number, currency = "MAD", locale = "fr-MA"): string {
  const v = cents / 100;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "code", minimumFractionDigits: 2 }).format(v).replace(/ /g, " ").replace(/ /g, " ");
  } catch { return `${v.toFixed(2)} ${currency}`; }
}
