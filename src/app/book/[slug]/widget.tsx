"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PublicShell, type PublicRestaurant } from "@/components/public-shell";
import { Button, Card, Field, Input, Notice, Select, Spinner, Switch, Textarea, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { OCCASIONS } from "@/lib/client/format";

interface Slot { time: string; available: boolean; reason?: string; service: string; durationMin: number }
const REASON: Record<string, string> = { full: "Fully booked", notice: "Too soon to book online", pacing: "Fully booked", service_cap: "Fully booked", window: "Too far ahead", party_large: "Please call us for larger groups" };

export function BookingWidget({ r, campaignId }: { r: PublicRestaurant; campaignId?: string }) {
  const { t, fmt, locale } = useI18n();
  const router = useRouter();
  const [party, setParty] = useState(Math.min(Math.max(2, r.minParty), r.maxPartyOnline));
  const [date, setDate] = useState(r.today);
  const [section, setSection] = useState("");
  const [slots, setSlots] = useState<{ closed: boolean; closedLabel: string | null; slots: Slot[] } | null>(null); const [loading, setLoading] = useState(false); const [slotsErr, setSlotsErr] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [hold, setHold] = useState<{ token: string; expiresAt: number } | null>(null); const [secs, setSecs] = useState(0);
  const [f, setF] = useState({ guestName: "", guestPhone: "", guestEmail: "", occasion: "", specialRequests: "", consentEmail: false, consentWhatsapp: false, website: "" });
  const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  const mounted = useRef(Date.now());

  const load = async () => {
    setLoading(true); setSlotsErr(null);
    try { setSlots(await api.get(`/api/public/restaurants/${r.slug}/slots${qs({ date, partySize: party, sectionId: section || undefined })}`)); } catch (e) { setSlots(null); setSlotsErr((e as ApiError).message); } finally { setLoading(false); }
  };
  useEffect(() => { setTime(null); setHold(null); if (!r.onlineBookingEnabled) return; const h = setTimeout(load, 150); return () => clearTimeout(h); }, [date, party, section]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(s: Slot) {
    setTime(s.time); setErr(null);
    try { const h = await api.post(`/api/public/restaurants/${r.slug}/holds`, { date, time: s.time, partySize: party, sectionId: section || undefined }); setHold({ token: h.holdToken, expiresAt: new Date(h.expiresAt).getTime() }); }
    catch (e) { setHold(null); setTime(null); setErr(e as ApiError); load(); }
  }
  useEffect(() => { if (!hold) { setSecs(0); return; } const i = setInterval(() => { const s = Math.max(0, Math.round((hold.expiresAt - Date.now()) / 1000)); setSecs(s); if (s === 0) { setHold(null); setTime(null); load(); } }, 1000); return () => clearInterval(i); }, [hold]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => { const m = new Map<string, Slot[]>(); for (const s of slots?.slots ?? []) m.set(s.service, [...(m.get(s.service) ?? []), s]); return [...m.entries()]; }, [slots]);
  const anyAvail = !!slots?.slots.some((s) => s.available);
  const needsDeposit = r.deposit && party >= r.deposit.minParty;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!time) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.post(`/api/public/restaurants/${r.slug}/bookings`, {
        date, time, partySize: party, guestName: f.guestName, guestPhone: f.guestPhone || undefined, guestEmail: f.guestEmail || undefined, occasion: f.occasion || undefined,
        specialRequests: f.specialRequests || undefined, sectionId: section || undefined, holdToken: hold?.token, campaignId, website: f.website, elapsedMs: Date.now() - mounted.current,
        language: locale, consent: { email: f.consentEmail && !!f.guestEmail, whatsapp: f.consentWhatsapp && !!f.guestPhone },
      });
      router.push(`${res.manageUrl}?new=1`);
    } catch (x) { setErr(x as ApiError); setBusy(false); if ((x as ApiError).status === 409) load(); }
  }
  const fe = err?.fields ?? {};

  if (!r.onlineBookingEnabled) {
    return <PublicShell r={r}><Card className="!p-8 text-center"><Icon name="phone" size={28} className="mx-auto text-muted" /><h2 className="mt-3 text-xl font-semibold">{t("Online booking is currently unavailable")}</h2><p className="text-muted mt-1">{t("Please call us to reserve a table.")}</p>{r.phone && <a href={`tel:${r.phone}`} className="inline-block mt-4"><Button variant="primary" icon="phone">{r.phone}</Button></a>}</Card></PublicShell>;
  }
  return (
    <PublicShell r={r}>
      <div className="grid md:grid-cols-[1fr_380px] gap-5 items-start">
        <div className="space-y-5">
          <Card className="animate-in">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><span className="size-7 rounded-full text-sm grid place-items-center text-white" style={{ background: "var(--brand)" }}>1</span>{t("Choose your table")}</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("Guests")}>
                <div className="flex items-center gap-2"><Button aria-label={t("Fewer guests")} onClick={() => setParty(Math.max(r.minParty, party - 1))} disabled={party <= r.minParty}>−</Button><div className="flex-1 text-center text-lg font-semibold tabular">{party} <span className="text-sm font-normal text-muted">{t(party === 1 ? "guest" : "guests")}</span></div><Button aria-label={t("More guests")} onClick={() => setParty(Math.min(r.maxPartyOnline, party + 1))} disabled={party >= r.maxPartyOnline}>+</Button></div>
              </Field>
              <Field label={t("Date")}><Input type="date" value={date} min={r.today} max={r.maxDate} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
              {r.seatingOptions.length > 1 && <Field label={t("Seating area")} className="sm:col-span-2"><Select value={section} onChange={(e) => setSection(e.target.value)}><option value="">{t("No preference")}</option>{r.seatingOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
            </div>
            <p className="text-xs text-muted mt-2">{t("Parties larger than {n}? Please call us.", { n: r.maxPartyOnline })}{r.phone ? ` ${r.phone}` : ""}</p>

            <div className="mt-5">
              <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-medium text-ink-2">{t("Available times")} · {fmt.date(date, { weekday: "long", day: "numeric", month: "long" })}</h3>{loading && <Spinner size={16} />}</div>
              {slotsErr && <Notice tone="bad">{slotsErr}</Notice>}
              {slots?.closed && <Notice tone="warn" title={t("Closed")}>{slots.closedLabel ?? t("We are closed on this date — please pick another day.")}</Notice>}
              {slots && !slots.closed && !anyAvail && <Notice tone="warn" title={t("No tables available")}>{t("Nothing is available for this party size on this date. Try another date or area.")}{r.waitlistOpen && <> <Link className="underline font-medium" href={`/waitlist/${r.slug}`}>{t("Join the waitlist")}</Link></>}</Notice>}
              <div className="space-y-4">
                {grouped.map(([svc, list]) => (
                  <div key={svc}>{grouped.length > 1 && <p className="text-xs uppercase tracking-wide text-muted mb-1.5">{svc}</p>}
                    <div className="flex flex-wrap gap-2">{list.map((s) => (
                      <button key={s.time} type="button" disabled={!s.available} onClick={() => pick(s)} aria-pressed={time === s.time} title={s.available ? "" : t(REASON[s.reason ?? "full"] ?? "Unavailable")}
                        className={cx("h-11 min-w-[4.5rem] px-3 rounded-xl border text-[15px] font-medium tabular transition", time === s.time ? "text-white border-transparent" : s.available ? "bg-surface border-line-strong hover:border-[var(--brand)]" : "bg-sunken text-muted/50 border-transparent line-through cursor-not-allowed")}
                        style={time === s.time ? { background: "var(--brand)" } : undefined}>{s.time}</button>))}</div></div>))}
              </div>
            </div>
          </Card>

          {time && (
            <Card className="animate-in">
              <h2 className="text-xl font-semibold mb-1 flex items-center gap-2"><span className="size-7 rounded-full text-sm grid place-items-center text-white" style={{ background: "var(--brand)" }}>2</span>{t("Your details")}</h2>
              {hold && <p className="text-xs text-muted mb-4 flex items-center gap-1.5"><Icon name="clock" size={13} />{t("Table held for you for {time}", { time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` })}</p>}
              <form onSubmit={submit} className="grid sm:grid-cols-2 gap-4" noValidate>
                <Field label={t("Full name")} error={fe.guestName} required className="sm:col-span-2"><Input value={f.guestName} onChange={(e) => setF({ ...f, guestName: e.target.value })} autoComplete="name" required /></Field>
                <Field label={t("Mobile phone")} error={fe.guestPhone} hint={t("Phone or email is required")}><Input type="tel" inputMode="tel" value={f.guestPhone} onChange={(e) => setF({ ...f, guestPhone: e.target.value })} autoComplete="tel" placeholder="06 12 34 56 78" /></Field>
                <Field label={t("Email")} error={fe.guestEmail}><Input type="email" value={f.guestEmail} onChange={(e) => setF({ ...f, guestEmail: e.target.value })} autoComplete="email" /></Field>
                <Field label={t("Occasion")} className="sm:col-span-2"><Select value={f.occasion} onChange={(e) => setF({ ...f, occasion: e.target.value })}><option value="">{t("None")}</option>{OCCASIONS.map((o) => <option key={o} value={o}>{t(o)}</option>)}</Select></Field>
                <Field label={t("Special requests")} className="sm:col-span-2" hint={t("Allergies, high chair, celebration… (we'll do our best)")}><Textarea rows={2} value={f.specialRequests} onChange={(e) => setF({ ...f, specialRequests: e.target.value })} maxLength={1000} /></Field>
                <div className="hidden" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label></div>
                <div className="sm:col-span-2 space-y-2.5 rounded-xl bg-sunken p-4">
                  <p className="text-xs text-muted">{t("Optional — we only send offers if you agree. You can unsubscribe at any time.")}</p>
                  <Switch checked={f.consentEmail} onChange={(v) => setF({ ...f, consentEmail: v })} disabled={!f.guestEmail} label={t("Send me news and offers by email")} />
                  <Switch checked={f.consentWhatsapp} onChange={(v) => setF({ ...f, consentWhatsapp: v })} disabled={!f.guestPhone} label={t("Send me news and offers by WhatsApp / SMS")} />
                </div>
                {needsDeposit && r.deposit && <div className="sm:col-span-2"><Notice tone="gold" title={t("Deposit required for parties of {n}+", { n: r.deposit.minParty })}>{t("A deposit of {amount} per guest applies. Online payment is not available yet: your booking will be marked pending and the restaurant will contact you to arrange it.", { amount: fmt.money(r.deposit.perGuest, r.deposit.currency) })}</Notice></div>}
                {err && !Object.keys(fe).length && <div className="sm:col-span-2"><Notice tone="bad" title={err.code === "NO_AVAILABILITY" || err.code === "TABLE_CONFLICT" ? t("That time was just taken") : undefined}>{err.message}</Notice></div>}
                <div className="sm:col-span-2"><Button type="submit" size="lg" loading={busy} disabled={!f.guestName.trim() || (!f.guestPhone && !f.guestEmail)} className="w-full text-white" style={{ background: "var(--brand)" }}>{t(r.autoConfirm && !needsDeposit ? "Confirm reservation" : "Request reservation")}</Button></div>
              </form>
            </Card>
          )}
        </div>

        <aside className="space-y-4 md:sticky md:top-4">
          <Card>
            <h3 className="font-semibold mb-3">{t("Your reservation")}</h3>
            <dl className="space-y-2 text-sm"><div className="flex justify-between"><dt className="text-muted">{t("Date")}</dt><dd className="font-medium">{fmt.date(date, { weekday: "short", day: "numeric", month: "short" })}</dd></div><div className="flex justify-between"><dt className="text-muted">{t("Time")}</dt><dd className="font-medium tabular">{time ?? "—"}</dd></div><div className="flex justify-between"><dt className="text-muted">{t("Guests")}</dt><dd className="font-medium">{party}</dd></div>{section && <div className="flex justify-between"><dt className="text-muted">{t("Area")}</dt><dd className="font-medium">{r.seatingOptions.find((s) => s.id === section)?.name}</dd></div>}</dl>
          </Card>
          <Card>
            <h3 className="font-semibold mb-2">{t("Opening hours")}</h3>
            <ul className="text-sm space-y-1.5">{r.services.map((s, i) => <li key={i} className="flex justify-between gap-3"><span className="text-muted">{s.name}</span><span className="tabular">{s.startTime} – {s.lastSeating}</span></li>)}</ul>
            <p className="text-xs text-muted mt-2">{t("Times show the last seating.")}</p>
          </Card>
          {(r.policy || r.cancelDeadlineHours > 0) && <Card><h3 className="font-semibold mb-2">{t("Booking policy")}</h3><p className="text-sm text-ink-2">{r.policy ?? t("Free cancellation up to {n} hours before your reservation.", { n: r.cancelDeadlineHours })}</p><p className="text-xs text-muted mt-2">{t("You'll receive a private link to change or cancel your reservation.")}</p></Card>}
          {r.gallery.length > 0 && <div className="grid grid-cols-3 gap-2">{r.gallery.slice(0, 6).map((g) => <img key={g} src={g} alt="" className="aspect-square rounded-xl object-cover" />)}</div>}
        </aside>
      </div>
    </PublicShell>
  );
}
