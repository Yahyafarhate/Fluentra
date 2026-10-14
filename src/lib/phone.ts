/** Normalizes phone numbers to a canonical E.164-like form. Moroccan defaults: 06/07 xx -> +2126/7xx. */
export function normalizePhone(raw: string | null | undefined, defaultCountry = "MA"): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s().-]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    if (defaultCountry === "MA" && /^0[5-7]\d{8}$/.test(s)) s = "+212" + s.slice(1);
    else if (/^\d{8,15}$/.test(s) && !s.startsWith("0")) s = "+" + s;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
export const normalizeEmail = (e: string | null | undefined) => {
  const v = e?.trim().toLowerCase();
  return v ? v : null;
};
