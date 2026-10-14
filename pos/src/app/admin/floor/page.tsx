"use client";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Field, Input, Loading, Modal, Notice, Select } from "@/components/ui";
import { AdminShell, OutletPicker, useOutlet } from "@/components/admin";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

interface Tbl { id: string; diningRoomId: string; label: string; seats: number; x: number; y: number; w: number; h: number; shape: string; active: boolean }
interface Layout { rooms: Array<{ id: string; name: string; active: boolean }>; tables: Tbl[]; stations: Array<{ id: string; name: string; kind: string; targetSeconds: number; active: boolean }> }

export default function FloorAdmin() { const t = useT(); return <AdminShell title={t("Floor & stations")}>{() => <Inner />}</AdminShell>; }

function Inner() {
  const t = useT();
  const { outlets, outlet, setOutletId } = useOutlet();
  const { data, loading, reload } = useApi<Layout>(outlet ? `/outlets/${outlet.id}/layout` : null);
  const [room, setRoom] = useState<string>(""); const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState<Tbl[]>([]);
  const [edit, setEdit] = useState<Partial<Tbl> | null>(null); const [newRoom, setNewRoom] = useState("");
  const [st, setSt] = useState<{ name: string; kind: string; target: string } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null); const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => { if (data) { setLocal(data.tables); if (!room || !data.rooms.some((r) => r.id === room)) setRoom(data.rooms[0]?.id ?? ""); } }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const guard = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (e) { setErr((e as ApiError).message); } };
  const tables = local.filter((x) => x.diningRoomId === room);

  const onDown = (e: React.PointerEvent, tb: Tbl) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); const r = canvas.current!.getBoundingClientRect(); drag.current = { id: tb.id, dx: e.clientX - r.left - tb.x, dy: e.clientY - r.top - tb.y }; };
  const onMove = (e: React.PointerEvent) => { const d = drag.current; if (!d) return; const r = canvas.current!.getBoundingClientRect(); const x = Math.max(0, Math.round((e.clientX - r.left - d.dx) / 10) * 10), y = Math.max(0, Math.round((e.clientY - r.top - d.dy) / 10) * 10); setLocal((l) => l.map((tb) => (tb.id === d.id ? { ...tb, x, y } : tb))); };
  const onUp = async () => { const d = drag.current; drag.current = null; if (!d) return; const tb = local.find((x) => x.id === d.id)!; await guard(() => api("PATCH", `/tables/${tb.id}`, { x: tb.x, y: tb.y })); };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2 items-center"><OutletPicker outlets={outlets} value={outlet?.id ?? ""} onChange={setOutletId} />
        {data?.rooms.map((r) => <Button key={r.id} size="sm" variant={room === r.id ? "primary" : "secondary"} onClick={() => setRoom(r.id)}>{r.name}</Button>)}
        <div className="flex gap-1 ms-auto"><Input value={newRoom} onChange={(e) => setNewRoom(e.target.value)} placeholder={t("New room name")} className="h-9 w-44" /><Button size="sm" disabled={!newRoom} onClick={() => guard(async () => { await api("POST", `/outlets/${outlet!.id}/rooms`, { name: newRoom }); setNewRoom(""); })}>+ {t("Room")}</Button></div></div>
      {outlet && <p className="text-sm text-ink-2">{t("Terminal code of this outlet")}: <Badge tone="gold" className="font-mono text-base tracking-widest">{outlet.code}</Badge> — {t("servers type it once on each POS device.")}</p>}
      {err && <Notice tone="bad">{err}</Notice>}
      {loading ? <Loading /> : !data?.rooms.length ? <Notice tone="info">{t("Create a dining room to start placing tables.")}</Notice> : (
        <>
          <div className="flex items-center gap-2"><Button disabled={!room} onClick={() => setEdit({ label: "", seats: 2, shape: "square", w: 90, h: 90, x: 20, y: 20 })}>+ {t("Table")}</Button><span className="text-sm text-muted">{t("Drag tables to place them. Click a table to edit it.")}</span></div>
          <div ref={canvas} onPointerMove={onMove} onPointerUp={onUp} className="relative rounded-2xl border border-line bg-sunken overflow-auto touch-none" style={{ height: 480, backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)", backgroundSize: "20px 20px" }}>
            {tables.map((tb) => <div key={tb.id} onPointerDown={(e) => onDown(e, tb)} onDoubleClick={() => setEdit(tb)} className={`absolute border-2 border-line-strong bg-surface flex flex-col items-center justify-center cursor-grab select-none ${tb.shape === "round" ? "rounded-full" : "rounded-2xl"} ${tb.active ? "" : "opacity-40"}`} style={{ left: tb.x, top: tb.y, width: tb.w, height: tb.h }}><b className="font-display text-lg">{tb.label}</b><span className="text-xs text-muted">{tb.seats} {t("seats")}</span><button onClick={(e) => { e.stopPropagation(); setEdit(tb); }} onPointerDown={(e) => e.stopPropagation()} className="absolute top-0.5 end-1 text-xs text-muted hover:text-ink" aria-label="edit">✎</button></div>)}
          </div>
          <div><h2 className="font-semibold mb-2 mt-2">{t("Preparation stations")}</h2>
            <div className="flex flex-wrap gap-2">{data.stations.map((s) => <Badge key={s.id} tone={s.active ? "info" : "neutral"}>{s.name} · {t(s.kind)} · {Math.round(s.targetSeconds / 60)} min</Badge>)}<Button size="sm" variant="secondary" onClick={() => setSt({ name: "", kind: "kitchen", target: "10" })}>+ {t("Station")}</Button></div></div>
        </>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t("Edit table") : t("New table")}
        footer={<>{edit?.id && <Button variant="ghost" className="text-bad me-auto" onClick={() => guard(async () => { await api("PATCH", `/tables/${edit.id}`, { active: !edit.active }); setEdit(null); })}>{edit.active ? t("Disable") : t("Enable")}</Button>}<Button variant="ghost" onClick={() => setEdit(null)}>{t("Cancel")}</Button><Button disabled={!edit?.label} onClick={() => guard(async () => { const b = { label: edit!.label, seats: Number(edit!.seats), shape: edit!.shape, w: Number(edit!.w), h: Number(edit!.h), ...(edit!.id ? {} : { x: edit!.x, y: edit!.y }) }; if (edit!.id) await api("PATCH", `/tables/${edit!.id}`, b); else await api("POST", `/rooms/${room}/tables`, b); setEdit(null); })}>{t("Save")}</Button></>}>
        {edit && <div className="grid grid-cols-2 gap-3"><Field label={t("Label")}><Input value={edit.label ?? ""} onChange={(e) => setEdit({ ...edit, label: e.target.value })} maxLength={20} /></Field><Field label={t("Seats")}><Input type="number" min={1} max={60} value={edit.seats ?? 2} onChange={(e) => setEdit({ ...edit, seats: Number(e.target.value) })} /></Field>
          <Field label={t("Shape")}><Select value={edit.shape} onChange={(e) => setEdit({ ...edit, shape: e.target.value })}>{["square", "round", "rect"].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label={t("Width")}><Input type="number" min={40} max={500} value={edit.w ?? 90} onChange={(e) => setEdit({ ...edit, w: Number(e.target.value) })} /></Field><Field label={t("Height")}><Input type="number" min={40} max={500} value={edit.h ?? 90} onChange={(e) => setEdit({ ...edit, h: Number(e.target.value) })} /></Field></div></div>}
      </Modal>
      <Modal open={!!st} onClose={() => setSt(null)} title={t("New station")} footer={<><Button variant="ghost" onClick={() => setSt(null)}>{t("Cancel")}</Button><Button disabled={!st?.name} onClick={() => guard(async () => { await api("POST", `/outlets/${outlet!.id}/stations`, { name: st!.name, kind: st!.kind, targetSeconds: Math.round(Number(st!.target) * 60) }); setSt(null); })}>{t("Save")}</Button></>}>
        {st && <div className="grid gap-3"><Field label={t("Name")}><Input value={st.name} onChange={(e) => setSt({ ...st, name: e.target.value })} /></Field><Field label={t("Type")}><Select value={st.kind} onChange={(e) => setSt({ ...st, kind: e.target.value })}>{["kitchen", "bar", "pastry"].map((k) => <option key={k} value={k}>{t(k)}</option>)}</Select></Field><Field label={t("Service-time target (minutes)")}><Input type="number" min={1} value={st.target} onChange={(e) => setSt({ ...st, target: e.target.value })} /></Field></div>}
      </Modal>
    </div>
  );
}
