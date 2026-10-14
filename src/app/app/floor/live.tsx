"use client";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app-shell";
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, Notice, Segmented, Select, Skeleton, StatusBadge, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { ReservationDrawer } from "@/components/reservation-drawer";
import { WalkInDialog } from "@/components/walkin-dialog";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi, useLive } from "@/lib/client/hooks";
import { TableNode, STATUS_STYLE, type FloorTable } from "./table-node";

const OFFSETS = [0, 30, 60, 120, 180];

export function LiveFloor() {
  const { t } = useI18n();
  const { locationId, can, today } = useApp();
  const { toast, confirm } = useFeedback();
  const [floorId, setFloorId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [section, setSection] = useState(""); const [minCap, setMinCap] = useState(""); const [statusF, setStatusF] = useState("");
  const [sel, setSel] = useState<string | null>(null); const [open, setOpen] = useState<string | null>(null);
  const [walk, setWalk] = useState<{ tableId?: string } | null>(null); const [spend, setSpend] = useState(""); const [busy, setBusy] = useState(false);
  const [hl, setHl] = useState<string | null>(null);

  const at = useMemo(() => (offset ? new Date(Date.now() + offset * 60000).toISOString() : undefined), [offset]);
  const { data, error, loading, reload } = useApi<any>(locationId ? `/api/v1/floor/state${qs({ locationId, at, horizonMin: offset ? 60 : 90 })}` : null);  
  const arrivals = useApi<{ reservations: any[] }>(locationId && today ? `/api/v1/reservations${qs({ locationId, date: today, status: "pending,confirmed,arrived", limit: 60 })}` : null);  
  const mode = useLive(locationId, () => { reload(); arrivals.reload(); });
  const refresh = () => { reload(); arrivals.reload(); };

  const floors = data?.floors ?? [];
  const floor = floors.find((f: { id: string }) => f.id === floorId) ?? floors[0];
  const tables: FloorTable[] = useMemo(() => data?.tables ?? [], [data]);
  const onFloor = tables.filter((x) => x.floorId === floor?.id);
  const selected = tables.find((x) => x.id === sel) ?? null;

  const matches = (x: FloorTable) => (!section || x.sectionId === section) && (!minCap || x.capacity >= Number(minCap)) && (!statusF || x.displayStatus === statusF);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const x of tables) c[x.displayStatus ?? "available"] = (c[x.displayStatus ?? "available"] ?? 0) + 1; return c; }, [tables]);

  async function act(path: string, body: Record<string, unknown>, msg: string) {
    setBusy(true);
    try { await api.post(path, body); toast.success(msg); refresh(); } catch (e) {
      const x = e as ApiError;
      if (x.code === "TABLE_NOT_READY" && body.action === "seat" && await confirm({ title: t("Table not ready"), message: x.message, confirmLabel: t("Seat anyway") })) { setBusy(false); return act(path, { ...body, force: true }, msg); }
      else toast.error(x);
    } finally { setBusy(false); }
  }
  const setStatus = (id: string, status: string, msg: string) => act(`/api/v1/floor/tables/${id}/status`, { status }, msg);

  const waiting = (arrivals.data?.reservations ?? []).filter((r) => r.status === "arrived");
  const upcoming = (arrivals.data?.reservations ?? []).filter((r) => r.status !== "arrived").slice(0, 8);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
      <div className="min-w-0 space-y-4">
        <Card className="!p-3 flex flex-wrap items-center gap-2">
          {floors.length > 1 && <Segmented value={floor?.id ?? ""} onChange={setFloorId} options={floors.map((f: { id: string; name: string }) => ({ value: f.id, label: f.name }))} />}
          <Select value={section} onChange={(e) => setSection(e.target.value)} className="!w-auto" aria-label={t("Section")}><option value="">{t("All sections")}</option>{(data?.sections ?? []).map((s: { id: string; name: string }) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Input type="number" min={1} placeholder={t("Seats ≥")} value={minCap} onChange={(e) => setMinCap(e.target.value)} className="!w-24" aria-label={t("Minimum seats")} />
          <Select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="!w-auto" aria-label={t("Status")}><option value="">{t("Any status")}</option>{["available", "reserved", "occupied", "cleaning", "blocked"].map((s) => <option key={s} value={s}>{t(s.charAt(0).toUpperCase() + s.slice(1))} ({counts[s] ?? 0})</option>)}</Select>
          <div className="ms-auto flex items-center gap-2">
            <span className="text-xs text-muted hidden sm:inline">{t("Reservations in the window starting")}</span>
            <Segmented value={String(offset)} onChange={(v) => setOffset(Number(v))} options={OFFSETS.map((o) => ({ value: String(o), label: o === 0 ? t("Now") : `+${o >= 60 ? o / 60 + "h" : o + "m"}` }))} />
            <span className={cx("size-2 rounded-full", mode === "live" ? "bg-ok animate-[fl-pulse_2s_infinite]" : "bg-warn")} title={mode === "live" ? t("Live") : t("Auto-refresh every 30s")} />
          </div>
        </Card>

        {loading ? <Skeleton className="h-[460px]" /> : !floor ? (
          <Card><EmptyState icon="floor" title={t("No floor plan yet")}>{t("Build your floor plan in the Layout editor tab.")}</EmptyState></Card>
        ) : onFloor.length === 0 ? (
          <Card><EmptyState icon="table" title={t("This floor has no tables")}>{can("floor.manage") ? t("Add tables in the Layout editor tab.") : t("Ask a manager to add tables.")}</EmptyState></Card>
        ) : (
          <div className="overflow-x-auto scroll-thin rounded-2xl border border-line bg-[linear-gradient(var(--color-sunken)_1px,transparent_1px),linear-gradient(90deg,var(--color-sunken)_1px,transparent_1px)] [background-size:24px_24px] bg-surface">
            <div dir="ltr" className="relative min-w-[760px] [container-type:inline-size]" style={{ aspectRatio: `${floor.width} / ${floor.height}` }}>
              {onFloor.map((x) => <TableNode key={x.id} t={x} floor={floor} mode="live" selected={sel === x.id || hl === x.id} dim={!matches(x)} onClick={() => setSel(x.id)} />)}
            </div>
          </div>
        )}
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="Legend">
          {(["available", "reserved", "occupied", "cleaning", "blocked"] as const).map((s) => <li key={s} className="flex items-center gap-1.5"><span className={cx("size-3.5 rounded border-2", STATUS_STYLE[s])} />{t(s.charAt(0).toUpperCase() + s.slice(1))} <span className="text-muted">{counts[s] ?? 0}</span></li>)}
        </ul>
      </div>

      <aside className="space-y-4">
        <Card>
          <div className="flex items-center justify-between mb-3"><h3 className="font-semibold">{t("Waiting to be seated")}</h3><Badge tone={waiting.length ? "violet" : "neutral"}>{waiting.length}</Badge></div>
          {waiting.length === 0 ? <p className="text-sm text-muted">{t("No arrived guests are waiting.")}</p> : (
            <ul className="space-y-2">{waiting.map((r) => (
              <li key={r.id} className="rounded-lg border border-line p-2.5 flex items-center gap-2" onMouseEnter={() => setHl(r.tables[0]?.id ?? null)} onMouseLeave={() => setHl(null)}>
                <div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{r.guestName}</p><p className="text-xs text-muted">{r.time} · {r.partySize}p · {r.tables.map((x: { name: string }) => x.name).join("+") || t("no table")}</p></div>
                {can("reservations.operate") && <Button size="sm" variant="gold" disabled={busy} onClick={() => r.tables.length ? act(`/api/v1/reservations/${r.id}/transition`, { action: "seat" }, t("Guests seated")) : setOpen(r.id)}>{t("Seat")}</Button>}
              </li>))}</ul>
          )}
        </Card>
        <Card>
          <div className="flex items-center justify-between mb-3"><h3 className="font-semibold">{t("Next up")}</h3><Badge>{upcoming.length}</Badge></div>
          {upcoming.length === 0 ? <p className="text-sm text-muted">{t("Nothing else booked today.")}</p> : (
            <ul className="space-y-1.5">{upcoming.map((r) => (
              <li key={r.id}><button className="w-full text-start rounded-lg px-2.5 py-2 hover:bg-sunken flex items-center gap-3" onClick={() => setOpen(r.id)} onMouseEnter={() => setHl(r.tables[0]?.id ?? null)} onMouseLeave={() => setHl(null)}>
                <span className="tabular font-semibold text-sm w-12">{r.time}</span><span className="min-w-0 flex-1 text-sm truncate">{r.guestName}</span><span className="text-xs text-muted">{r.partySize}p · {r.tables.map((x: { name: string }) => x.name).join("+") || "—"}</span></button></li>))}</ul>
          )}
        </Card>
        {can("reservations.operate") && <Button className="w-full" variant="primary" icon="utensils" onClick={() => setWalk({})}>{t("Seat a walk-in")}</Button>}
      </aside>

      <Dialog open={!!selected} onClose={() => setSel(null)} side size="sm" title={selected ? <span className="inline-flex items-center gap-2">{t("Table")} {selected.name}</span> : ""}
        description={selected ? <span className="inline-flex items-center gap-2"><StatusBadge status={selected.displayStatus ?? "available"} />{selected.capacity} {t("seats")}</span> : undefined}>
        {selected && (
          <div className="space-y-4 pt-1">
            {selected.displayStatus === "blocked" && <Notice tone="bad">{selected.blockedReason ?? t("Blocked")}</Notice>}
            {selected.current && (
              <div className="rounded-xl border border-violet/40 bg-violet-soft/40 p-3 text-sm">
                <p className="font-semibold">{selected.current.guestName} {selected.current.isVip && <Icon name="crown" size={14} className="inline text-gold" />}</p>
                <p className="text-ink-2">{selected.current.partySize} {t("guests")} · {t("seated")} {selected.current.seatedAt ? Math.round((Date.now() - new Date(selected.current.seatedAt).getTime()) / 60000) : 0} min · {t("expected until")} {selected.current.endLocal}</p>
                <div className="mt-3 flex flex-wrap gap-2 items-end">
                  <Field label={t("Spend (optional)")} className="w-32"><Input type="number" min={0} inputMode="decimal" value={spend} onChange={(e) => setSpend(e.target.value)} /></Field>
                  {can("reservations.operate") && <Button variant="primary" icon="check" disabled={busy} onClick={() => act(`/api/v1/reservations/${selected.current!.id}/transition`, { action: "complete", spendAmount: spend ? Number(spend) : undefined }, t("Visit completed — table released")).then(() => { setSpend(""); setSel(null); })}>{t("Complete visit")}</Button>}
                  <Button onClick={() => setOpen(selected.current!.id)}>{t("Details")}</Button>
                </div>
              </div>
            )}
            {selected.next && selected.displayStatus !== "occupied" && (
              <div className="rounded-xl border border-info/40 bg-info-soft/40 p-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-muted mb-1">{t("Next reservation")}</p>
                <p className="font-semibold">{selected.next.guestName} <StatusBadge status={selected.next.status} /></p>
                <p className="text-ink-2">{selected.next.startLocal} · {selected.next.partySize} {t("guests")}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {can("reservations.operate") && selected.next.status === "confirmed" && <Button size="sm" onClick={() => act(`/api/v1/reservations/${selected.next!.id}/transition`, { action: "arrive" }, t("Guest arrived"))}>{t("Mark arrived")}</Button>}
                  {can("reservations.operate") && selected.displayStatus !== "cleaning" && selected.displayStatus !== "blocked" && <Button size="sm" variant="gold" disabled={busy} onClick={() => act(`/api/v1/reservations/${selected.next!.id}/transition`, { action: "seat" }, t("Guests seated")).then(() => setSel(null))}>{t("Seat now")}</Button>}
                  <Button size="sm" onClick={() => setOpen(selected.next!.id)}>{t("Details")}</Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {can("reservations.operate") && (selected.displayStatus === "available" || selected.displayStatus === "reserved") && <Button variant="primary" icon="utensils" onClick={() => { setWalk({ tableId: selected.id }); setSel(null); }}>{t("Seat walk-in here")}</Button>}
              {can("floor.operate") && selected.displayStatus === "cleaning" && <Button variant="primary" icon="broom" disabled={busy} onClick={() => setStatus(selected.id, "available", t("Table ready")).then(() => setSel(null))}>{t("Mark ready")}</Button>}
              {can("floor.operate") && selected.displayStatus === "blocked" && <Button variant="primary" disabled={busy} onClick={() => setStatus(selected.id, "available", t("Table unblocked")).then(() => setSel(null))}>{t("Unblock")}</Button>}
              {can("floor.operate") && (selected.displayStatus === "available" || selected.displayStatus === "reserved") && <Button icon="ban" disabled={busy} onClick={() => setStatus(selected.id, "blocked", t("Table blocked")).then(() => setSel(null))}>{t("Block table")}</Button>}
              {can("floor.operate") && selected.displayStatus === "available" && <Button icon="broom" disabled={busy} onClick={() => setStatus(selected.id, "cleaning", t("Marked as awaiting cleaning")).then(() => setSel(null))}>{t("Needs cleaning")}</Button>}
            </div>
          </div>
        )}
      </Dialog>

      <WalkInDialog open={!!walk} onClose={() => setWalk(null)} onDone={refresh} presetTableId={walk?.tableId} />
      <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh} onEdit={() => { setOpen(null); toast.info(t("Open the Reservations page to edit details.")); }} />
    </div>
  );
}
