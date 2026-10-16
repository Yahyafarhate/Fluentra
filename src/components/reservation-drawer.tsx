"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar, Badge, Button, Dialog, ErrorState, Field, Input, Notice, Select, Skeleton, StatusBadge, Textarea } from "./ui";
import { Icon } from "./icons";
import { useApp } from "./app-shell";
import { useFeedback } from "./feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { SOURCE_LABEL } from "@/lib/client/format";

type Action = "confirm" | "arrive" | "seat" | "complete" | "cancel" | "no_show" | "undo_arrive" | "undo_seat" | "reinstate" | "move_table";

export function ReservationDrawer({ id, onClose, onChanged, onEdit }: { id: string | null; onClose: () => void; onChanged: () => void; onEdit: (r: any) => void }) {  
  const { t, fmt } = useI18n();
  const { can, locationId } = useApp();
  const { toast, confirm } = useFeedback();
  const { data: r, error, loading, reload } = useApi<any>(id ? `/api/v1/reservations/${id}` : null);  
  const [busy, setBusy] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | "cancel" | "complete" | "table">(null);
  const [reason, setReason] = useState(""); const [spend, setSpend] = useState("");
  const [freeTables, setFreeTables] = useState<Array<{ id: string; name: string; capacity: number; displayStatus: string }>>([]);
  const [pick, setPick] = useState("");
  const [assign, setAssign] = useState<{ partySize: number; suggested: string[]; tables: Array<{ id: string; name: string; capacity: number }> }>({ partySize: 0, suggested: [], tables: [] });
  const [picks, setPicks] = useState<string[]>([]);
  const operate = can("reservations.operate");

  useEffect(() => { setDlg(null); setReason(""); setSpend(""); }, [id]);

  async function run(action: Action, extra: Record<string, unknown> = {}, label?: string) {
    if (!id) return;
    setBusy(action);
    try {
      await api.post(`/api/v1/reservations/${id}/transition`, { action, ...extra });
      toast.success(label ?? t("Done"));
      setDlg(null); await reload(); onChanged();
    } catch (e) {
      const x = e as ApiError;
      if (x.code === "TABLE_NOT_READY" && action === "seat") {
        if (await confirm({ title: t("Table not ready"), message: x.message + " — " + t("Seat the party anyway?"), confirmLabel: t("Seat anyway") })) return run("seat", { ...extra, force: true }, label);
      } else if (x.code === "NO_TABLE") { await openTables(); }
      else if (x.code === "TOO_EARLY_FOR_NO_SHOW") {
        if (await confirm({ title: t("Mark as no-show?"), message: x.message, confirmLabel: t("Mark no-show anyway"), tone: "danger" })) return run("no_show", { force: true }, label);
      } else toast.error(x);
    } finally { setBusy(null); }
  }

  async function openTables() {
    if (!r || !locationId) return;
    try {
      if (r.status === "seated") {
        const mv = await api.get(`/api/v1/reservations/${id}/move-targets`);
        setFreeTables(mv.tables.map((x: { id: string; name: string; capacity: number }) => ({ ...x, displayStatus: "available" })));
        setPick(""); setDlg("table"); return;
      }
      const a = await api.get(`/api/v1/reservations/${id}/assignable-tables`);
      setAssign(a); setPicks(a.current.length ? a.current : a.suggested); setDlg("table");
    } catch (e) { toast.error(e); }
  }

  const status = r?.status as string | undefined;
  const active = status && ["pending", "confirmed", "arrived", "seated"].includes(status);
  const tables = (r?.tables ?? []) as Array<{ id: string; name: string; status: string }>;
  const c = r?.customer;

  return (
    <>
      <Dialog open={!!id} onClose={onClose} side title={r ? <span className="inline-flex items-center gap-2">{r.guestName}{r.isVip && <Icon name="crown" size={18} className="text-gold" />}</span> : t("Reservation")}
        description={r ? <span className="inline-flex items-center gap-2"><StatusBadge status={r.status} /><span className="font-mono text-xs">{r.code}</span></span> : undefined}
        footer={r && operate && (
          <div className="w-full flex flex-wrap gap-2 justify-end">
            {status === "pending" && <><Button variant="primary" icon="check" loading={busy === "confirm"} onClick={() => run("confirm", {}, t("Reservation confirmed"))}>{t("Confirm")}</Button></>}
            {status === "confirmed" && <Button variant="primary" icon="user" loading={busy === "arrive"} onClick={() => run("arrive", {}, t("Guest arrived"))}>{t("Mark arrived")}</Button>}
            {(status === "confirmed" || status === "arrived" || status === "pending") && <Button variant={status === "arrived" ? "primary" : "secondary"} icon="utensils" loading={busy === "seat"} onClick={() => run("seat", {}, t("Guests seated"))}>{t("Seat")}</Button>}
            {status === "seated" && <Button variant="primary" icon="check" onClick={() => setDlg("complete")}>{t("Complete visit")}</Button>}
            {status === "arrived" && <Button variant="ghost" onClick={() => run("undo_arrive")}>{t("Undo arrival")}</Button>}
            {status === "seated" && <Button variant="ghost" onClick={() => run("undo_seat")}>{t("Undo seating")}</Button>}
            {status === "no_show" && <Button variant="primary" icon="refresh" loading={busy === "reinstate"} onClick={() => run("reinstate", {}, t("Reservation reinstated"))}>{t("Reinstate")}</Button>}
            {(status === "pending" || status === "confirmed") && <Button variant="ghost" onClick={() => run("no_show", {}, t("Marked as no-show"))}>{t("No-show")}</Button>}
            {(status === "pending" || status === "confirmed" || status === "arrived") && <Button variant="ghost" className="!text-bad" onClick={() => setDlg("cancel")}>{t("Cancel reservation")}</Button>}
          </div>
        )}>
        {loading && <div className="space-y-3 pt-2"><Skeleton className="h-20" /><Skeleton className="h-32" /><Skeleton className="h-24" /></div>}
        {error && <ErrorState error={error} onRetry={reload} />}
        {r && (
          <div className="space-y-5 pt-1">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl bg-sunken p-3"><p className="text-xs text-muted">{t("Date")}</p><p className="font-semibold mt-0.5">{fmt.date(r.serviceDate)}</p></div>
              <div className="rounded-xl bg-sunken p-3"><p className="text-xs text-muted">{t("Time")}</p><p className="font-semibold mt-0.5 tabular">{r.time}<span className="text-muted font-normal"> → {r.endTime}</span></p></div>
              <div className="rounded-xl bg-sunken p-3"><p className="text-xs text-muted">{t("Guests")}</p><p className="font-semibold mt-0.5">{r.partySize}</p></div>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">{t("Table")}</dt>
              <dd className="flex flex-wrap items-center gap-1.5">{tables.length ? tables.map((x) => <Badge key={x.id} tone="dark">{x.name}</Badge>) : <span className="text-muted">{t("Not assigned")}</span>}
                {operate && active && status !== "seated" && <button className="text-xs text-gold-strong underline" onClick={openTables}>{tables.length ? t("change") : t("assign")}</button>}
                {operate && status === "seated" && <button className="text-xs text-gold-strong underline" onClick={openTables}>{t("move")}</button>}</dd>
              <dt className="text-muted">{t("Source")}</dt><dd>{t(SOURCE_LABEL[r.source] ?? r.source)}</dd>
              {r.guestPhone && <><dt className="text-muted">{t("Phone")}</dt><dd className="flex items-center gap-2"><a className="hover:underline" href={`tel:${r.guestPhone}`}>{r.guestPhone}</a><a className="text-ok text-xs underline" target="_blank" rel="noreferrer" href={`https://wa.me/${r.guestPhone.replace(/\D/g, "")}`}>WhatsApp</a></dd></>}
              {r.guestEmail && <><dt className="text-muted">{t("Email")}</dt><dd><a className="hover:underline" href={`mailto:${r.guestEmail}`}>{r.guestEmail}</a></dd></>}
              {r.occasion && <><dt className="text-muted">{t("Occasion")}</dt><dd><Badge tone="gold">{t(r.occasion)}</Badge></dd></>}
              {r.seatingPreference && <><dt className="text-muted">{t("Seating")}</dt><dd>{r.seatingPreference}</dd></>}
              {r.depositAmount > 0 && <><dt className="text-muted">{t("Deposit")}</dt><dd className="flex items-center gap-2">{fmt.money(r.depositAmount)} <Badge tone={r.depositStatus === "paid" ? "ok" : r.depositStatus === "pending" ? "warn" : "neutral"}>{t(r.depositStatus)}</Badge></dd></>}
            </dl>

            {status === "pending" && r.groupingAccepted && <Notice tone="warn" title={t("Table grouping to validate")}>{t("This party is bigger than any single table. The guest accepted that tables are put together: check the proposed tables (or choose others with “change”), then confirm.")}</Notice>}
            {r.specialRequests && <Notice tone="gold" title={t("Special requests")}>{r.specialRequests}</Notice>}
            {r.internalNotes && <div className="rounded-xl border border-line p-3 text-sm"><p className="text-xs font-semibold uppercase tracking-wide text-muted mb-1 flex items-center gap-1.5"><Icon name="lock" size={13} />{t("Internal notes")}</p>{r.internalNotes}</div>}

            {c && can("customers.read") && (
              <div className="rounded-xl border border-line p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={c.name} vip={c.vip} />
                  <div className="min-w-0 flex-1"><p className="font-medium truncate">{c.name}</p><p className="text-xs text-muted">{c.visits} {t("visits")}{c.lastVisit ? ` · ${t("last visit")} ${fmt.date(c.lastVisit, { day: "numeric", month: "short", year: "numeric" })}` : ""}</p></div>
                  <Link href={`/app/guests/${c.id}`} className="text-sm text-gold-strong hover:underline">{t("Profile")}</Link>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {c.vip && <Badge tone="gold">VIP</Badge>}
                  {c.allergies?.map((a: string) => <Badge key={a} tone="bad">⚠ {a}</Badge>)}
                  {c.dietary?.map((a: string) => <Badge key={a} tone="info">{a}</Badge>)}
                  {c.tags?.map((a: string) => <Badge key={a}>{a}</Badge>)}
                  {c.noShows > 0 && <Badge tone="warn">{c.noShows} {t("no-shows")}</Badge>}
                </div>
                {c.notes && <p className="text-sm text-ink-2 mt-3">{c.notes}</p>}
                {c.seatingPreferences && <p className="text-sm text-ink-2 mt-1.5"><span className="text-muted">{t("Prefers")}:</span> {c.seatingPreferences}</p>}
              </div>
            )}

            {r.depositStatus === "pending" && can("reservations.write") && active && (
              <div className="flex gap-2 items-center text-sm"><span className="text-muted">{t("Deposit")}:</span>
                <Button size="sm" onClick={async () => { await api.patch(`/api/v1/reservations/${id}`, { depositStatus: "paid" }); toast.success(t("Marked as paid")); reload(); }}>{t("Mark paid")}</Button>
                <Button size="sm" onClick={async () => { await api.patch(`/api/v1/reservations/${id}`, { depositStatus: "waived" }); toast.success(t("Deposit waived")); reload(); }}>{t("Waive")}</Button></div>
            )}

            <ol className="text-xs text-muted space-y-1 border-s-2 border-line ps-4">
              <li>{t("Booked")}: {fmt.date(r.createdAt, { dateStyle: "medium", timeStyle: "short" })}{r.rescheduleCount > 0 ? ` · ${t("rescheduled {n}×", { n: r.rescheduleCount })}` : ""}</li>
              {r.arrivedAt && <li>{t("Arrived")}: {fmt.date(r.arrivedAt, { timeStyle: "short" })}</li>}
              {r.seatedAt && <li>{t("Seated")}: {fmt.date(r.seatedAt, { timeStyle: "short" })}</li>}
              {r.completedAt && <li>{t("Completed")}: {fmt.date(r.completedAt, { timeStyle: "short" })}</li>}
              {r.cancelledAt && <li>{t("Cancelled")} ({r.cancelledBy}): {fmt.date(r.cancelledAt, { dateStyle: "medium", timeStyle: "short" })}{r.cancelReason ? ` — ${r.cancelReason}` : ""}</li>}
            </ol>

            <div className="flex flex-wrap gap-2">
              {can("reservations.write") && active && <Button size="sm" icon="edit" onClick={() => onEdit(r)}>{t("Edit")}</Button>}
              <Button size="sm" icon="link" onClick={async () => { await navigator.clipboard?.writeText(location.origin + r.manageLink); toast.success(t("Guest link copied")); }}>{t("Copy guest link")}</Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={dlg === "cancel"} onClose={() => setDlg(null)} size="sm" title={t("Cancel reservation")}
        footer={<><Button onClick={() => setDlg(null)}>{t("Keep")}</Button><Button variant="danger" loading={busy === "cancel"} onClick={() => run("cancel", { reason: reason || undefined }, t("Reservation cancelled"))}>{t("Cancel reservation")}</Button></>}>
        <p className="text-sm text-ink-2 mb-3">{t("The table is released immediately and the guest is notified if a message channel is available.")}</p>
        <Field label={t("Reason (optional)")}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>

      <Dialog open={dlg === "complete"} onClose={() => setDlg(null)} size="sm" title={t("Complete visit")}
        footer={<><Button onClick={() => setDlg(null)}>{t("Back")}</Button><Button variant="primary" loading={busy === "complete"} onClick={() => run("complete", { spendAmount: spend ? Number(spend) : undefined }, t("Visit completed — table released"))}>{t("Complete & release table")}</Button></>}>
        <p className="text-sm text-ink-2 mb-3">{t("The table moves to “awaiting cleaning” (or straight back to available, depending on your workflow).")}</p>
        <Field label={t("Total spend (optional)")} hint={t("Only entered amounts feed revenue reports. Leave empty if unknown.")}><Input type="number" min={0} step="1" inputMode="decimal" value={spend} onChange={(e) => setSpend(e.target.value)} placeholder="0" /></Field>
      </Dialog>

      <Dialog open={dlg === "table"} onClose={() => setDlg(null)} size="sm" title={status === "seated" ? t("Move to another table") : t("Choose a table")}
        footer={status === "seated"
          ? <><Button onClick={() => setDlg(null)}>{t("Cancel")}</Button><Button variant="gold" disabled={!pick} loading={busy === "move_table"} onClick={() => run("move_table", { tableIds: [pick] }, t("Guests moved — the old table is awaiting cleaning"))}>{t("Move guests")}</Button></>
          : <><Button onClick={() => setDlg(null)}>{t("Cancel")}</Button>
            <Button variant="primary" disabled={!picks.length} loading={busy === "seat"} onClick={async () => {
              try { await api.patch(`/api/v1/reservations/${id}`, { tableIds: picks }); toast.success(t("Table assigned")); setDlg(null); reload(); onChanged(); } catch (e) { toast.error(e); }
            }}>{t("Assign table")}</Button>
            {operate && <Button variant="gold" disabled={!picks.length} loading={busy === "seat"} onClick={() => run("seat", { tableIds: picks }, t("Guests seated"))}>{t("Assign & seat")}</Button>}</>}>
        {status === "seated" && <p className="text-sm text-ink-2 mb-3">{t("The guests keep their reservation. The table they leave goes to “awaiting cleaning”, the new one becomes occupied.")}</p>}
        {status === "seated"
          ? (freeTables.length === 0 ? <p className="text-sm text-muted">{t("No suitable table is free right now.")}</p> : (
            <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("Table")}><option value="">{t("Select…")}</option>{freeTables.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.capacity} {t("seats")}</option>)}</Select>
          ))
          : assign.tables.length === 0 ? <p className="text-sm text-muted">{t("No suitable table is free right now.")}</p> : (() => {
            const seats = assign.tables.filter((x) => picks.includes(x.id)).reduce((n, x) => n + x.capacity, 0);
            return <div className="space-y-3">
              <p className="text-sm text-ink-2">{t("Pick one table, or several to put them together.")}</p>
              <div className="max-h-64 overflow-y-auto space-y-1.5" role="group" aria-label={t("Tables")}>
                {assign.tables.map((x) => <label key={x.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={picks.includes(x.id)} onChange={(e) => setPicks(e.target.checked ? [...picks, x.id] : picks.filter((i) => i !== x.id))} />
                  <span className="flex-1 font-medium">{x.name}</span><span className="text-muted">{x.capacity} {t("seats")}</span>
                </label>)}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className={seats >= assign.partySize ? "text-ok font-medium" : "text-warn font-medium"}>{seats} / {assign.partySize} {t("seats")}</span>
                {assign.suggested.length > 0 && <button type="button" className="text-xs text-gold-strong underline" onClick={() => setPicks(assign.suggested)}>{t("Suggest the closest tables")}</button>}
              </div>
            </div>;
          })()}
      </Dialog>
    </>
  );
}
