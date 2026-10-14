export const money = (cents: number | null | undefined, currency = "MAD") => {
  const v = (cents ?? 0) / 100;
  const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v).replace(/,/g, " ");
  return `${n} ${currency}`;
};
export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0).replace(/\.00$/, "")}%`;
export const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
export const hhmm = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—");
export const dateTime = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
export const today = () => new Date().toLocaleDateString("sv-SE");
export const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toLocaleDateString("sv-SE");
export const minutesSince = (d: string | Date) => Math.floor((Date.now() - new Date(d).getTime()) / 60000);
