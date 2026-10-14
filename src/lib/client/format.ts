export const SOURCES = ["phone", "online", "walk_in", "instagram", "whatsapp", "google", "email", "staff", "other"] as const;
export const SOURCE_LABEL: Record<string, string> = {
  phone: "Phone", online: "Online", walk_in: "Walk-in", instagram: "Instagram", whatsapp: "WhatsApp", google: "Google", email: "Email", staff: "Staff", other: "Other",
};
export const OCCASIONS = ["Birthday", "Anniversary", "Business dinner", "Engagement", "Date night", "Family gathering", "Celebration"];
export const timeFromIso = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(iso));
export const minutesSince = (iso: string | Date) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
export const shiftDate = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
export const waLink = (phone: string) => `https://wa.me/${phone.replace(/\D/g, "")}`;
