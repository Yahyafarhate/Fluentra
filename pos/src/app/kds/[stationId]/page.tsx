"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Badge, Button, ErrorState, Loading, Notice } from "@/components/ui";
import { useMe } from "@/components/pos-shell";
import { api, ApiError } from "@/lib/client/api";
import { useApi, useLive, useNow, useOnline } from "@/lib/client/hooks";
import { mmss } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface TItem { id: string; name: string; qty: number; status: string; course: number; seat: number | null; note: string | null; allergyNote: string | null; modifiers: string[]; cancelled: boolean }
interface Ticket { orderId: string; orderNo: number; type: string; tableLabel: string | null; covers: number; serverName: string | null; firedAt: string; level: "ok" | "warn" | "late"; hasAllergy: boolean; allItemsReady: boolean; items: TItem[] }
interface Board { station: { id: string; name: string; kind: string; targetSeconds: number }; tickets: Ticket[]; recent: Ticket[] }

const LEVEL = { ok: "border-white/15 bg-charcoal-2", warn: "border-warn bg-[#3a2f17]", late: "border-bad bg-[#3d1f1b] animate-[fl-pulse_1.6s_infinite]" } as const;

export default function KdsBoard() {
  const t = useT(); const { stationId } = useParams<{ stationId: string }>(); const me = useMe();
  const { data, error, loading, reload } = useApi<Board>(`/stations/${stationId}/board`);
  const mode = useLive(me?.outletId ?? null, reload, 3000);
  const online = useOnline(); const now = useNow(1000);
  const [err, setErr] = useState<string | null>(null); const [showRecent, setShowRecent] = useState(false); const [busy, setBusy] = useState(false);

  const act = useCallback(async (action: "accept" | "start" | "ready" | "recall", body: { orderId?: string; itemIds?: string[] }) => {
    setBusy(true); setErr(null);
    try { await api("POST", `/stations/${stationId}/action`, { action, ...body }); await reload(); } catch (e) { setErr((e as ApiError).message); await reload(); } finally { setBusy(false); }
  }, [stationId, reload]);

  if (loading || !me) return <div className="min-h-dvh bg-charcoal"><Loading /></div>;
  if (error || !data) return <div className="min-h-dvh bg-charcoal text-white"><ErrorState error={error} retry={reload} /></div>;
  const list = showRecent ? data.recent : data.tickets;

  return (
    <main className="min-h-dvh bg-charcoal text-white">
      <header className="h-14 px-4 flex items-center gap-3 border-b border-white/10 sticky top-0 bg-charcoal z-10">
        <Link href="/kds" className="text-white/60 hover:text-white">←</Link><h1 className="text-xl font-semibold">{data.station.name}</h1>
        <Badge tone={online ? "ok" : "bad"}>{online ? (mode === "live" ? t("Live") : t("Online")) : t("Offline — screen not updating")}</Badge>
        <span className="text-white/50 text-sm">{data.tickets.length} {t("tickets")} · {t("target")} {Math.round(data.station.targetSeconds / 60)} min</span>
        <div className="ms-auto flex gap-2"><Button size="sm" variant={showRecent ? "gold" : "ghost"} className={showRecent ? "" : "text-white"} onClick={() => setShowRecent(!showRecent)}>{showRecent ? t("Back to live tickets") : t("Recently completed (recall)")}</Button></div>
      </header>
      {err && <div className="p-3"><Notice tone="bad">{err}</Notice></div>}
      {list.length === 0 ? <div className="text-center text-white/50 py-24 text-xl">{showRecent ? t("Nothing completed recently") : t("All clear — no ticket waiting")}</div> : (
        <div className="p-3 grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 items-start">
          {list.map((tk) => {
            const el = Math.max(0, Math.floor((now - new Date(tk.firedAt).getTime()) / 1000));
            const ids = (s: string[]) => tk.items.filter((i) => s.includes(i.status)).map((i) => i.id);
            return (
              <article key={tk.orderId} className={`rounded-2xl border-2 p-3 ${showRecent ? "border-white/10 bg-charcoal-2" : LEVEL[tk.level]}`}>
                <div className="flex items-baseline justify-between"><div className="text-2xl font-bold">{tk.tableLabel ? `${t("Table")} ${tk.tableLabel}` : t(tk.type)}</div><div className="text-xl tabular font-mono">{showRecent ? "" : mmss(el)}</div></div>
                <div className="text-sm text-white/60">#{tk.orderNo} · {tk.serverName}{tk.covers ? ` · ${tk.covers} ${t("guests")}` : ""}</div>
                {tk.hasAllergy && <div className="mt-2 rounded-lg bg-bad px-2 py-1 text-sm font-bold">⚠ {t("ALLERGY")}</div>}
                <ul className="mt-2 grid gap-2">
                  {tk.items.map((i) => (
                    <li key={i.id} className={`rounded-xl px-2 py-2 ${i.cancelled ? "bg-bad/20 line-through opacity-70" : i.status === "ready" ? "bg-ok/25" : i.status === "preparing" ? "bg-gold/20" : "bg-white/5"}`}>
                      <div className="flex gap-2 items-start"><span className="font-bold text-lg w-8">{i.qty}×</span>
                        <div className="flex-1"><div className="text-lg leading-tight font-medium">{i.name}</div>{i.modifiers.length > 0 && <div className="text-white/80">{i.modifiers.join(" · ")}</div>}{i.note && <div className="text-info">“{i.note}”</div>}{i.allergyNote && <div className="font-bold text-[#ff8a7d]">⚠ {i.allergyNote}</div>}
                          <div className="text-xs text-white/50">{i.seat ? `${t("Seat")} ${i.seat} · ` : ""}{t("Course")} {i.course}{i.cancelled ? ` · ${t("CANCELLED")}` : ""}</div></div>
                        {!showRecent && !i.cancelled && !["served"].includes(i.status) && (
                          <div className="flex flex-col gap-1">
                            {i.status === "fired" && <button disabled={busy} onClick={() => act("accept", { itemIds: [i.id] })} className="h-9 px-3 rounded-lg bg-white/10 text-sm">{t("Accept")}</button>}
                            {["fired", "accepted"].includes(i.status) && <button disabled={busy} onClick={() => act("start", { itemIds: [i.id] })} className="h-9 px-3 rounded-lg bg-gold text-charcoal text-sm font-semibold">{t("Start")}</button>}
                            {["fired", "accepted", "preparing"].includes(i.status) && <button disabled={busy} onClick={() => act("ready", { itemIds: [i.id] })} className="h-9 px-3 rounded-lg bg-ok text-white text-sm font-semibold">{t("Ready")}</button>}
                            {i.status === "ready" && <button disabled={busy} onClick={() => act("recall", { itemIds: [i.id] })} className="h-9 px-3 rounded-lg bg-white/10 text-sm">{t("Recall")}</button>}
                          </div>)}
                        {showRecent && ["ready", "served"].includes(i.status) && <button disabled={busy} onClick={() => act("recall", { itemIds: [i.id] })} className="h-9 px-3 rounded-lg bg-white/10 text-sm">{t("Recall")}</button>}
                      </div>
                    </li>
                  ))}
                </ul>
                {!showRecent && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button variant="secondary" className="bg-white/10 text-white border-white/20" disabled={busy || !ids(["fired", "accepted"]).length} onClick={() => act("start", { orderId: tk.orderId })}>{t("Start all")}</Button>
                    <Button variant="gold" disabled={busy || !ids(["fired", "accepted", "preparing"]).length} onClick={() => act("ready", { orderId: tk.orderId })}>{t("Bump (all ready)")}</Button>
                  </div>)}
              </article>
            );
          })}
        </div>)}
    </main>
  );
}
