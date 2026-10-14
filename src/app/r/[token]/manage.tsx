"use client";
import { useEffect, useState } from "react";
import { PublicShell } from "@/components/public-shell";
import { Button, Card, Dialog, Field, Input, Notice, Select, Spinner, StatusBadge, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";

interface Res {
  code: string; status: string; partySize: number; startAt: string; date: string; time: string; guestName: string; occasion: string | null; specialRequests: string | null;
  deposit: { status: string; amount: number }; canCancel: boolean; canModify: boolean; changeDeadline: string;
  restaurant: { slug: string; name: string; address: string | null; city: string | null; phone: string | null; timezone: string; brandColor: string; locale: string; policy: string | null };
}

export function ManageReservation({ token, initial, justBooked }: { token: string; initial: Res; justBooked: boolean }) {
  const { t, fmt } = useI18n();
  const [r, setR] = useState<Res>(initial);
  const [dlg, setDlg] = useState<null | "cancel" | "modify">(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  const [date, setDate] = useState(r.date); const [party, setParty] = useState(r.partySize); const [time, setTime] = useState(r.time);
  const [slots, setSlots] = useState<Array<{ time: string; available: boolean }>>([]); const [loadingSlots, setLoadingSlots] = useState(false);
  const reload = async () => setR(await api.get(`/api/public/reservations/${token}`));
  useEffect(() => {
    if (dlg !== "modify") return;
    setLoadingSlots(true);
    api.get(`/api/public/restaurants/${r.restaurant.slug}/slots${qs({ date, partySize: party })}`).then((x) => setSlots(x.slots)).catch(() => setSlots([])).finally(() => setLoadingSlots(false));
  }, [dlg, date, party, r.restaurant.slug]);

  async function cancel() { setBusy(true); setErr(null); try { await api.del(`/api/public/reservations/${token}`); setDlg(null); await reload(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }
  async function modify() { setBusy(true); setErr(null); try { await api.patch(`/api/public/reservations/${token}`, { date, time, partySize: party }); setDlg(null); await reload(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }

  const status = r.status; const live = ["pending", "confirmed"].includes(status);
  const ics = () => {
    const [h, m] = r.time.split(":").map(Number); const d = r.date.replace(/-/g, "");
    const start = `${d}T${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`; const endH = Math.min(23, h + 2);
    const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fluentra//EN", "BEGIN:VEVENT", `UID:${r.code}@fluentra`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, `DTSTART;TZID=${r.restaurant.timezone}:${start}`, `DTEND;TZID=${r.restaurant.timezone}:${d}T${String(endH).padStart(2, "0")}${String(m).padStart(2, "0")}00`, `SUMMARY:${r.restaurant.name} (${r.partySize})`, `LOCATION:${[r.restaurant.address, r.restaurant.city].filter(Boolean).join(", ")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "text/calendar" })); a.download = `reservation-${r.code}.ics`; a.click();
  };
  const heading = status === "cancelled" ? t("Reservation cancelled") : status === "pending" ? t("Request received") : status === "no_show" ? t("Reservation missed") : status === "completed" ? t("Thank you for visiting") : justBooked ? t("You're booked!") : t("Your reservation");
  return (
    <PublicShell r={{ ...r.restaurant, logoUrl: null, coverUrl: null }} narrow>
      <Card className="animate-in">
        <div className="text-center">
          <div className={cx("mx-auto size-14 rounded-full grid place-items-center", status === "cancelled" || status === "no_show" ? "bg-bad-soft text-bad" : status === "pending" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}><Icon name={status === "cancelled" || status === "no_show" ? "x" : status === "pending" ? "clock" : "check"} size={26} /></div>
          <h2 className="text-2xl font-semibold mt-4">{heading}</h2>
          {justBooked && status === "pending" && <p className="text-sm text-ink-2 mt-1">{t("{name} will confirm your request shortly.", { name: r.restaurant.name })}</p>}
          {justBooked && status === "confirmed" && <p className="text-sm text-ink-2 mt-1">{t("A confirmation was sent if an email or phone number is connected to messaging. Keep this page — it's your private link.")}</p>}
        </div>
        <dl className="mt-6 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl bg-sunken p-3"><dt className="text-xs text-muted">{t("Date")}</dt><dd className="font-semibold mt-0.5">{fmt.date(r.date, { weekday: "short", day: "numeric", month: "short" })}</dd></div>
          <div className="rounded-xl bg-sunken p-3"><dt className="text-xs text-muted">{t("Time")}</dt><dd className="font-semibold mt-0.5 tabular">{r.time}</dd></div>
          <div className="rounded-xl bg-sunken p-3"><dt className="text-xs text-muted">{t("Guests")}</dt><dd className="font-semibold mt-0.5">{r.partySize}</dd></div>
        </dl>
        <div className="mt-4 flex items-center justify-between text-sm"><span className="text-muted">{t("Reservation code")}</span><span className="font-mono font-semibold tracking-wider">{r.code}</span></div>
        <div className="mt-2 flex items-center justify-between text-sm"><span className="text-muted">{t("Status")}</span><StatusBadge status={status} /></div>
        {r.occasion && <div className="mt-2 flex items-center justify-between text-sm"><span className="text-muted">{t("Occasion")}</span><span>{t(r.occasion)}</span></div>}
        {r.deposit.amount > 0 && <div className="mt-4"><Notice tone="gold" title={t("Deposit: {amount}", { amount: fmt.money(r.deposit.amount) })}>{r.deposit.status === "paid" ? t("Received — thank you.") : t("Not yet paid. The restaurant will contact you to arrange it.")}</Notice></div>}
        {live && (
          <div className="mt-6 space-y-3">
            <div className="flex flex-wrap gap-2 justify-center"><Button icon="calendar" onClick={ics}>{t("Add to calendar")}</Button><a target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([r.restaurant.name, r.restaurant.address, r.restaurant.city].filter(Boolean).join(", "))}`}><Button icon="pin">{t("Directions")}</Button></a>{r.restaurant.phone && <a href={`tel:${r.restaurant.phone}`}><Button icon="phone">{t("Call")}</Button></a>}</div>
            <div className="flex flex-wrap gap-2 justify-center">
              <Button variant="primary" disabled={!r.canModify} onClick={() => { setErr(null); setDate(r.date); setParty(r.partySize); setTime(r.time); setDlg("modify"); }}>{t("Change date, time or guests")}</Button>
              <Button variant="ghost" className="!text-bad" disabled={!r.canCancel} onClick={() => { setErr(null); setDlg("cancel"); }}>{t("Cancel reservation")}</Button>
            </div>
            {(!r.canCancel || !r.canModify) && <p className="text-xs text-center text-muted">{t("Online changes close {date}. Please call the restaurant.", { date: fmt.date(r.changeDeadline, { dateStyle: "medium", timeStyle: "short", timeZone: r.restaurant.timezone }) })}</p>}
            {r.canCancel && <p className="text-xs text-center text-muted">{t("Free cancellation until {date}.", { date: fmt.date(r.changeDeadline, { dateStyle: "medium", timeStyle: "short", timeZone: r.restaurant.timezone }) })}</p>}
          </div>
        )}
        {r.restaurant.policy && <p className="mt-6 text-xs text-muted border-t border-line pt-4">{r.restaurant.policy}</p>}
      </Card>

      <Dialog open={dlg === "cancel"} onClose={() => setDlg(null)} size="sm" title={t("Cancel this reservation?")} footer={<><Button onClick={() => setDlg(null)}>{t("Keep it")}</Button><Button variant="danger" loading={busy} onClick={cancel}>{t("Yes, cancel")}</Button></>}>
        <p className="text-sm text-ink-2">{t("Your table will be released for other guests.")}</p>{err && <div className="mt-3"><Notice tone="bad">{err.message}</Notice></div>}
      </Dialog>
      <Dialog open={dlg === "modify"} onClose={() => setDlg(null)} size="md" title={t("Change your reservation")} footer={<><Button onClick={() => setDlg(null)}>{t("Close")}</Button><Button variant="primary" loading={busy} disabled={!time || (date === r.date && time === r.time && party === r.partySize)} onClick={modify}>{t("Save changes")}</Button></>}>
        <div className="space-y-4 pt-1"><div className="grid grid-cols-2 gap-3"><Field label={t("Date")}><Input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => { setDate(e.target.value); setTime(""); }} /></Field><Field label={t("Guests")}><Input type="number" min={1} max={20} value={party} onChange={(e) => { setParty(Math.max(1, Number(e.target.value) || 1)); setTime(""); }} /></Field></div>
          <div><p className="text-[13px] font-medium text-ink-2 mb-2 flex items-center gap-2">{t("Time")}{loadingSlots && <Spinner size={14} />}</p><div className="flex flex-wrap gap-2">{slots.map((s) => <button key={s.time} disabled={!s.available && !(date === r.date && s.time === r.time)} onClick={() => setTime(s.time)} className={cx("h-10 px-3 rounded-lg border text-sm tabular", time === s.time ? "bg-charcoal text-white border-charcoal" : s.available ? "border-line-strong hover:border-gold" : "bg-sunken text-muted/50 line-through")}>{s.time}</button>)}</div></div>
          {err && <Notice tone="bad">{err.message}</Notice>}</div>
      </Dialog>
    </PublicShell>
  );
}
void Select;
