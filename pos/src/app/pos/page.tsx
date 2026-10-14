"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Empty, ErrorState, Loading, Modal, Tabs } from "@/components/ui";
import { PosShell, useMe } from "@/components/pos-shell";
import { api, newKey, ApiError } from "@/lib/client/api";
import { useApi, useLive, useNow } from "@/lib/client/hooks";
import type { Floor, FloorTable } from "@/lib/client/types";
import { mmss } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

const STATUS_STYLE: Record<FloorTable["status"], string> = {
  available: "bg-surface border-line-strong text-ink-2",
  occupied: "bg-info-soft border-info text-info",
  ordered: "bg-gold-soft border-gold text-gold-strong",
  awaiting_payment: "bg-violet-soft border-violet text-violet",
};

export default function FloorPage() {
  const t = useT();
  const router = useRouter();
  const me = useMe();
  const { data: floor, error, loading, reload } = useApi<Floor>(me?.outletId ? `/outlets/${me.outletId}/floor` : null);
  const mode = useLive(me?.outletId ?? null, reload, 8000);
  const now = useNow(15000);
  const [room, setRoom] = useState<string | null>(null);
  const [pick, setPick] = useState<FloorTable | null>(null);
  const [choose, setChoose] = useState<FloorTable | null>(null);
  const [covers, setCovers] = useState(2);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const keyRef = useRef(newKey("open"));

  useEffect(() => { if (floor && !room) setRoom(floor.rooms[0]?.id ?? null); }, [floor, room]);
  const tables = useMemo(() => floor?.tables.filter((x) => x.diningRoomId === room) ?? [], [floor, room]);
  const canvas = useMemo(() => ({ w: Math.max(400, ...tables.map((x) => x.x + x.w + 20)), h: Math.max(300, ...tables.map((x) => x.y + x.h + 20)) }), [tables]);
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1.4, Math.max(0.4, el.clientWidth / canvas.w)))); ro.observe(el);
    return () => ro.disconnect();
  }, [canvas.w]);

  async function openOrder(body: Record<string, unknown>) {
    if (!me?.outletId) return; setBusy(true); setMsg(null);
    try {
      const r = await api<{ order: { id: string } }>("POST", "/orders", { outletId: me.outletId, ...body }, { idempotencyKey: keyRef.current });
      keyRef.current = newKey("open"); router.push(`/pos/order/${r.order.id}`);
    } catch (e) { setMsg((e as ApiError).message); setBusy(false); reload(); }
  }
  const tap = (tb: FloorTable) => {
    if (tb.status === "available") { setCovers(Math.min(2, tb.seats)); setPick(tb); }
    else if (tb.orders.length > 1) setChoose(tb);
    else if (tb.order) router.push(`/pos/order/${tb.order.id}`);
  };

  return (
    <PosShell me={me} active="floor">
      <div className="p-3 sm:p-4 max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {floor && floor.rooms.length > 0 && <Tabs tabs={floor.rooms.map((r) => ({ id: r.id, label: r.name }))} value={room ?? ""} onChange={setRoom} />}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => openOrder({ type: "takeaway" })}>+ {t("Takeaway")}</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => openOrder({ type: "delivery" })}>+ {t("Delivery")}</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { const ref = window.prompt(t("Room number")); if (ref) openOrder({ type: "room_service", roomRef: ref }); }}>+ {t("Room service")}</Button>
          </div>
        </div>
        {msg && <div className="mb-3"><Badge tone="bad">{msg}</Badge></div>}
        {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : !floor || floor.rooms.length === 0 ? <Empty title={t("No dining room yet")} hint={t("Create rooms and tables in the back office (Floor).")} /> : (
          <>
            <div ref={wrap} className="rounded-2xl border border-line bg-sunken overflow-hidden" style={{ height: canvas.h * scale + 8 }}>
              <div className="relative" style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                {tables.map((tb) => {
                  const el = tb.order ? Math.max(0, Math.floor((now - new Date(tb.order.openedAt).getTime()) / 60000)) : 0;
                  return (
                    <button key={tb.id} onClick={() => tap(tb)} aria-label={`${tb.label} ${t(tb.status)}`}
                      className={`tbl absolute border-2 flex flex-col items-center justify-center text-center ${STATUS_STYLE[tb.status]} ${tb.shape === "round" ? "rounded-full" : "rounded-2xl"} ${tb.order?.alert ? "ring-4 ring-bad/60" : ""}`}
                      style={{ left: tb.x, top: tb.y, width: tb.w, height: tb.h }}>
                      <span className="font-display text-xl font-semibold leading-none">{tb.label}</span>
                      {tb.order ? <><span className="text-xs mt-1">{tb.order.covers}👤 · #{tb.order.orderNo}{tb.checks > 1 ? ` (${tb.checks})` : ""}</span><span className="text-xs tabular">{mmss(el * 60).slice(0, 5).replace(/^0/, "")}{"′"}</span></> : <span className="text-xs mt-1">{tb.seats} {t("seats")}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 items-center text-xs">
              {(Object.keys(STATUS_STYLE) as FloorTable["status"][]).map((s) => <span key={s} className={`px-2 py-1 rounded-lg border ${STATUS_STYLE[s]}`}>{t(s)}</span>)}
              <span className="px-2 py-1 rounded-lg border-2 border-bad/60 text-bad">{t("Long stay")}</span>
              <span className="ml-auto text-muted">{mode === "live" ? t("Live") : t("Refreshing every few seconds")}</span>
            </div>
            {floor.quickOrders.length > 0 && (
              <div className="mt-4"><h2 className="font-semibold mb-2">{t("Orders without a table")}</h2>
                <div className="flex flex-wrap gap-2">{floor.quickOrders.map((q) => <Button key={q.id} variant="secondary" onClick={() => router.push(`/pos/order/${q.id}`)}>#{q.orderNo} · {t(q.type)}</Button>)}</div></div>
            )}
          </>
        )}
      </div>

      <Modal open={!!pick} onClose={() => setPick(null)} title={pick ? `${t("Open table")} ${pick.label}` : ""}
        footer={<><Button variant="ghost" onClick={() => setPick(null)}>{t("Cancel")}</Button><Button disabled={busy || covers < 1} onClick={() => pick && openOrder({ tableId: pick.id, covers })}>{t("Open")}</Button></>}>
        <p className="text-sm text-ink-2 mb-3">{t("How many guests?")}</p>
        <div className="grid grid-cols-4 gap-2">{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <button key={n} onClick={() => setCovers(n)} className={`h-14 rounded-xl text-xl font-medium border ${covers === n ? "bg-charcoal text-white border-charcoal" : "border-line-strong hover:bg-sunken"}`}>{n}</button>)}</div>
      </Modal>
      <Modal open={!!choose} onClose={() => setChoose(null)} title={choose ? `${t("Checks on")} ${choose.label}` : ""}>
        <div className="grid gap-2">{choose?.orders.map((o) => <Button key={o.id} variant="secondary" size="lg" onClick={() => router.push(`/pos/order/${o.id}`)}>#{o.orderNo}{o.billRequested ? ` · ${t("awaiting_payment")}` : ""}</Button>)}</div>
      </Modal>
    </PosShell>
  );
}
