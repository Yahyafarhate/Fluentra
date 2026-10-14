"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, Notice, Segmented, Select, Skeleton, Switch } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { TableNode, type FloorTable } from "./table-node";

const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export function Editor() {
  const { t } = useI18n();
  const { locationId } = useApp();
  const { toast, confirm } = useFeedback();
  const { data, error, loading, reload } = useApi<any>(locationId ? `/api/v1/floor/state${qs({ locationId })}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [tables, setTables] = useState<FloorTable[]>([]);
  const [floorId, setFloorId] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [comboDlg, setComboDlg] = useState(false); const [floorDlg, setFloorDlg] = useState<null | "new" | "edit">(null); const [sectionDlg, setSectionDlg] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const version = useRef(0);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  // sync from server only when nothing is pending locally
  useEffect(() => { if (data && dirtyRef.current.size === 0) setTables(data.tables); }, [data]);
  const floors = data?.floors ?? [];
  const floor = floors.find((f: { id: string }) => f.id === floorId) ?? floors[0];
  const onFloor = tables.filter((x) => x.floorId === floor?.id);
  const selTables = tables.filter((x) => sel.includes(x.id));
  const one = selTables.length === 1 ? selTables[0] : null;

  /* ───── autosave of geometry ───── */
  const flush = useCallback(async () => {
    const ids = [...dirtyRef.current]; if (!ids.length || !locationId) return;
    const v = version.current; setSaveState("saving");
    try {
      const payload = tablesRef.current.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h), rotation: Math.round(x.rotation), floorId: x.floorId }));
      await api.put("/api/v1/floor/layout", { locationId, tables: payload });
      if (version.current === v) { setDirty(new Set()); setSaveState("saved"); } else setSaveState("dirty");
    } catch (e) { setSaveState("error"); toast.error(e); }
  }, [locationId, toast]);
  const tablesRef = useRef(tables); tablesRef.current = tables;
  useEffect(() => {
    if (dirty.size === 0) return;
    setSaveState((s) => (s === "saving" ? s : "dirty"));
    const h = setTimeout(flush, 900);
    return () => clearTimeout(h);
  }, [dirty, tables, flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current.size) { e.preventDefault(); } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const patchLocal = (ids: string[], fn: (t: FloorTable) => Partial<FloorTable>) => {
    version.current++;
    setTables((cur) => cur.map((x) => (ids.includes(x.id) ? { ...x, ...fn(x) } : x)));
    setDirty((d) => new Set([...d, ...ids]));
  };

  /* ───── drag & resize ───── */
  function startDrag(e: React.PointerEvent, tb: FloorTable) {
    if (e.button !== 0 || !floor || !canvas.current) return;
    e.preventDefault();
    const ids = e.shiftKey ? (sel.includes(tb.id) ? sel.filter((i) => i !== tb.id) : [...sel, tb.id]) : sel.includes(tb.id) ? sel : [tb.id];
    setSel(ids);
    if (e.shiftKey) return;
    const scale = floor.width / canvas.current.getBoundingClientRect().width;
    const origin = Object.fromEntries(tablesRef.current.filter((x) => ids.includes(x.id)).map((x) => [x.id, { x: x.x, y: x.y, w: x.w, h: x.h }]));
    const sx = e.clientX, sy = e.clientY; let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) * scale, dy = (ev.clientY - sy) * scale;
      if (!moved && Math.hypot(dx, dy) < 3) return; moved = true;
      patchLocal(ids, (x) => ({ x: Math.max(0, Math.min(floor.width - origin[x.id].w, snap(origin[x.id].x + dx))), y: Math.max(0, Math.min(floor.height - origin[x.id].h, snap(origin[x.id].y + dy))) }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  function startResize(e: React.PointerEvent, tb: FloorTable) {
    e.stopPropagation(); e.preventDefault();
    if (!floor || !canvas.current) return;
    const scale = floor.width / canvas.current.getBoundingClientRect().width;
    const sx = e.clientX, sy = e.clientY, w0 = tb.w, h0 = tb.h;
    const move = (ev: PointerEvent) => {
      let w = Math.max(40, Math.min(600, snap(w0 + (ev.clientX - sx) * scale))), h = Math.max(40, Math.min(600, snap(h0 + (ev.clientY - sy) * scale)));
      if (tb.shape !== "rect") { const s = Math.max(w, h); w = s; h = s; }
      patchLocal([tb.id], () => ({ w, h }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  function onKey(e: React.KeyboardEvent) {
    if (!sel.length || !floor || (e.target as HTMLElement).closest("input,select,textarea")) return;
    const step = e.shiftKey ? 1 : GRID; const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) { e.preventDefault(); patchLocal(sel, (x) => ({ x: Math.max(0, Math.min(floor.width - x.w, x.x + d[e.key][0])), y: Math.max(0, Math.min(floor.height - x.h, x.y + d[e.key][1])) })); }
    if (e.key === "Delete" || e.key === "Backspace") { if (sel.length === 1) void removeSelected(); }
  }

  /* ───── CRUD ───── */
  async function addTable(shape: "rect" | "round" | "square") {
    if (!floor || !locationId) return;
    await flush();
    const used = new Set(tables.map((x) => x.name)); let n = tables.length + 1; while (used.has(`T${n}`)) n++;
    const size = shape === "rect" ? { w: 100, h: 70 } : { w: 80, h: 80 };
    try {
      const r = await api.post("/api/v1/floor/tables", { locationId, floorId: floor.id, name: `T${n}`, capacity: shape === "rect" ? 4 : 2, shape, x: snap(40 + (tables.length % 6) * 30), y: snap(40 + (tables.length % 6) * 30), ...size });
      await reload(); setSel([r.id]); toast.success(t("Table added"));
    } catch (e) { toast.error(e); }
  }
  async function removeSelected() {
    if (!one) return;
    if (!(await confirm({ title: t("Remove table {name}?", { name: one.name }), message: t("Tables with reservation history are archived, not erased. Tables with upcoming reservations cannot be removed."), tone: "danger", confirmLabel: t("Remove") }))) return;
    try { await api.del(`/api/v1/floor/tables/${one.id}`); setSel([]); setDirty((d) => { const n = new Set(d); n.delete(one.id); return n; }); await reload(); toast.success(t("Table removed")); } catch (e) { toast.error(e); }
  }

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <Skeleton className="h-[480px]" />;

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-5" onKeyDown={onKey}>
      <div className="min-w-0 space-y-3">
        <Card className="!p-3 flex flex-wrap items-center gap-2">
          {floors.length > 0 && <Segmented value={floor?.id ?? ""} onChange={(v) => { setFloorId(v); setSel([]); }} options={floors.map((f: { id: string; name: string }) => ({ value: f.id, label: f.name }))} />}
          <Button size="sm" icon="plus" onClick={() => setFloorDlg("new")}>{t("Floor")}</Button>
          {floor && <Button size="sm" icon="edit" onClick={() => setFloorDlg("edit")}>{t("Edit floor")}</Button>}
          <span className="mx-1 h-6 w-px bg-line" />
          <Button size="sm" variant="primary" icon="plus" onClick={() => addTable("rect")} disabled={!floor}>{t("Rectangular")}</Button>
          <Button size="sm" onClick={() => addTable("round")} disabled={!floor}>{t("Round")}</Button>
          <Button size="sm" onClick={() => addTable("square")} disabled={!floor}>{t("Square")}</Button>
          <span className="ms-auto text-xs flex items-center gap-1.5" role="status">
            {saveState === "saved" && <><Icon name="check" size={14} className="text-ok" />{t("All changes saved")}</>}
            {saveState === "saving" && <>{t("Saving…")}</>}
            {saveState === "dirty" && <span className="text-warn">{t("Unsaved changes…")}</span>}
            {saveState === "error" && <><span className="text-bad">{t("Save failed")}</span><Button size="sm" onClick={flush}>{t("Retry")}</Button></>}
          </span>
        </Card>
        {!floor ? <Card><EmptyState icon="floor" title={t("Create your first floor")} action={<Button variant="primary" onClick={() => setFloorDlg("new")}>{t("Add floor")}</Button>} /></Card> : (
          <div className="overflow-x-auto scroll-thin rounded-2xl border border-line bg-surface [background-image:linear-gradient(var(--color-sunken)_1px,transparent_1px),linear-gradient(90deg,var(--color-sunken)_1px,transparent_1px)] [background-size:24px_24px]">
            <div ref={canvas} dir="ltr" className="relative min-w-[760px] [container-type:inline-size] outline-none" tabIndex={0} style={{ aspectRatio: `${floor.width} / ${floor.height}` }}
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSel([]); }} aria-label={t("Floor plan canvas. Drag tables to move them; arrow keys nudge the selected table.")}>
              {onFloor.length === 0 && <div className="absolute inset-0 grid place-items-center text-sm text-muted pointer-events-none">{t("Add a table to get started")}</div>}
              {onFloor.map((x) => (
                <TableNode key={x.id} t={x} floor={floor} mode="edit" selected={sel.includes(x.id)} onPointerDown={(e) => startDrag(e, x)}>
                  {sel.length === 1 && sel[0] === x.id && <span onPointerDown={(e) => startResize(e, x)} className="absolute bottom-0 end-0 size-4 bg-gold rounded-tl-md cursor-nwse-resize" style={{ touchAction: "none" }} aria-label={t("Resize")} />}
                </TableNode>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted">{t("Drag to move · corner handle to resize · Shift+click to select several (e.g. to combine them) · arrow keys nudge · everything is saved automatically.")}</p>
      </div>

      <aside className="space-y-4">
        {one ? <TableInspector key={one.id} tb={one} sections={data?.sections ?? []} floors={floors} patchLocal={patchLocal} onSaved={reload} onRemove={removeSelected} />
          : selTables.length > 1 ? (
            <Card><CardHeader title={t("{n} tables selected", { n: selTables.length })} />
              <p className="text-sm text-ink-2 mb-3">{t("Combine them so they can be booked together for larger parties.")}</p>
              <Button variant="primary" onClick={() => setComboDlg(true)}>{t("Create combination")}</Button></Card>
          ) : (
            <Card><CardHeader title={t("Select a table")} subtitle={t("Click a table to edit its name, seats, shape and section.")} /><Notice tone="info">{t("Tables currently seated or reserved keep their status; layout changes never move reservations.")}</Notice></Card>
          )}
        <SectionsAndCombos data={data} locationId={locationId!} onChanged={reload} onAddSection={() => setSectionDlg(true)} />
      </aside>

      <ComboDialog open={comboDlg} onClose={() => setComboDlg(false)} tables={selTables} locationId={locationId!} onDone={() => { setComboDlg(false); setSel([]); reload(); }} />
      <FloorDialog mode={floorDlg} floor={floor} locationId={locationId!} onClose={() => setFloorDlg(null)} onDone={async (id) => { setFloorDlg(null); await reload(); if (id) setFloorId(id); }} />
      <SectionDialog open={sectionDlg} onClose={() => setSectionDlg(false)} locationId={locationId!} onDone={() => { setSectionDlg(false); reload(); }} />
    </div>
  );
}

function TableInspector({ tb, sections, floors, patchLocal, onSaved, onRemove }: { tb: FloorTable; sections: Array<{ id: string; name: string }>; floors: Array<{ id: string; name: string }>; patchLocal: (ids: string[], fn: (t: FloorTable) => Partial<FloorTable>) => void; onSaved: () => void; onRemove: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const [f, setF] = useState({ name: tb.name, capacity: tb.capacity, minCapacity: tb.minCapacity, shape: tb.shape, sectionId: tb.sectionId ?? "", bookableOnline: tb.bookableOnline, floorId: tb.floorId });
  const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  const changed = f.name !== tb.name || f.capacity !== tb.capacity || f.minCapacity !== tb.minCapacity || f.shape !== tb.shape || (f.sectionId || null) !== tb.sectionId || f.bookableOnline !== tb.bookableOnline || f.floorId !== tb.floorId;
  async function save() {
    setBusy(true); setErr(null);
    try { await api.patch(`/api/v1/floor/tables/${tb.id}`, { name: f.name, capacity: f.capacity, minCapacity: f.minCapacity, shape: f.shape, sectionId: f.sectionId || null, bookableOnline: f.bookableOnline, floorId: f.floorId }); toast.success(t("Table saved")); onSaved(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const fe = err?.fields ?? {};
  return (
    <Card>
      <CardHeader title={t("Table {name}", { name: tb.name })} action={<Badge>{tb.capacity} {t("seats")}</Badge>} />
      <div className="space-y-3">
        <Field label={t("Name")} error={fe.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={30} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Seats")} error={fe.capacity}><Input type="number" min={1} max={100} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} /></Field>
          <Field label={t("Min. party")} error={fe.minCapacity}><Input type="number" min={1} value={f.minCapacity} onChange={(e) => setF({ ...f, minCapacity: Number(e.target.value) })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Shape")}><Select value={f.shape} onChange={(e) => { const shape = e.target.value as FloorTable["shape"]; setF({ ...f, shape }); if (shape !== "rect") patchLocal([tb.id], (x) => { const s = Math.max(x.w, x.h); return { w: s, h: s, shape }; }); else patchLocal([tb.id], () => ({ shape })); }}>
            <option value="rect">{t("Rectangular")}</option><option value="round">{t("Round")}</option><option value="square">{t("Square")}</option></Select></Field>
          <Field label={t("Section")}><Select value={f.sectionId} onChange={(e) => setF({ ...f, sectionId: e.target.value })}><option value="">—</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        </div>
        {floors.length > 1 && <Field label={t("Floor")}><Select value={f.floorId} onChange={(e) => setF({ ...f, floorId: e.target.value })}>{floors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>}
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("Width")}><Input type="number" min={40} max={600} step={10} value={tb.w} onChange={(e) => patchLocal([tb.id], (x) => { const w = Math.max(40, Number(e.target.value)); return x.shape === "rect" ? { w } : { w, h: w }; })} /></Field>
          <Field label={t("Height")}><Input type="number" min={40} max={600} step={10} value={tb.h} disabled={tb.shape !== "rect"} onChange={(e) => patchLocal([tb.id], () => ({ h: Math.max(40, Number(e.target.value)) }))} /></Field>
          <Field label={t("Rotation")}><Input type="number" min={0} max={359} step={15} value={tb.rotation} onChange={(e) => patchLocal([tb.id], () => ({ rotation: ((Number(e.target.value) % 360) + 360) % 360 }))} /></Field>
        </div>
        <Switch checked={f.bookableOnline} onChange={(v) => setF({ ...f, bookableOnline: v })} label={t("Bookable online")} description={t("Off = staff-only table (never offered on the public booking page).")} />
        {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}
        <div className="flex gap-2 pt-1"><Button variant="primary" loading={busy} disabled={!changed} onClick={save}>{t("Save table")}</Button><Button variant="ghost" className="!text-bad ms-auto" icon="trash" onClick={onRemove}>{t("Remove")}</Button></div>
      </div>
    </Card>
  );
}

function SectionsAndCombos({ data, locationId, onChanged, onAddSection }: { data: any; locationId: string; onChanged: () => void; onAddSection: () => void }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t } = useI18n(); const { toast, confirm } = useFeedback();
  const tableName = (id: string) => data?.tables.find((x: { id: string }) => x.id === id)?.name ?? "?";
  async function del(kind: "sections" | "combinations", id: string, label: string) {
    if (!(await confirm({ title: t("Delete {name}?", { name: label }), tone: "danger", confirmLabel: t("Delete") }))) return;
    try { await api.del(`/api/v1/floor/${kind}/${id}`); onChanged(); toast.success(t("Deleted")); } catch (e) { toast.error(e); }
  }
  void locationId;
  return (
    <Card>
      <CardHeader title={t("Dining areas")} action={<Button size="sm" icon="plus" onClick={onAddSection}>{t("Section")}</Button>} />
      {data?.sections.length ? <ul className="space-y-1.5 mb-5">{data.sections.map((s: { id: string; name: string; kind: string }) => <li key={s.id} className="flex items-center gap-2 text-sm"><Badge tone={s.kind === "outdoor" ? "ok" : s.kind === "private" ? "violet" : "neutral"}>{t(s.kind)}</Badge><span className="flex-1 truncate">{s.name}</span><button className="text-muted hover:text-bad p-1" aria-label={t("Delete")} onClick={() => del("sections", s.id, s.name)}><Icon name="trash" size={15} /></button></li>)}</ul> : <p className="text-sm text-muted mb-5">{t("No sections yet.")}</p>}
      <h4 className="text-sm font-semibold mb-2">{t("Table combinations")}</h4>
      {data?.combos.length ? <ul className="space-y-1.5">{data.combos.map((c: { id: string; name: string; capacity: number; tableIds: string[] }) => <li key={c.id} className="flex items-center gap-2 text-sm"><span className="flex-1 truncate"><b className="font-medium">{c.name}</b> <span className="text-muted">· {c.tableIds.map(tableName).join(" + ")} · {c.capacity} {t("seats")}</span></span><button className="text-muted hover:text-bad p-1" aria-label={t("Delete")} onClick={() => del("combinations", c.id, c.name)}><Icon name="trash" size={15} /></button></li>)}</ul> : <p className="text-sm text-muted">{t("Select two or more tables (Shift+click) to combine them for large parties.")}</p>}
    </Card>
  );
}

function ComboDialog({ open, onClose, tables, locationId, onDone }: { open: boolean; onClose: () => void; tables: FloorTable[]; locationId: string; onDone: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const total = tables.reduce((n, x) => n + x.capacity, 0);
  const [name, setName] = useState(""); const [cap, setCap] = useState(total); const [min, setMin] = useState(1); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (open) { setName(tables.map((x) => x.name).join("+")); setCap(total); setMin(Math.max(...tables.map((x) => x.capacity)) + 1); setErr(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  async function go() { setBusy(true); setErr(null); try { await api.post("/api/v1/floor/combinations", { locationId, name, capacity: cap, minCapacity: min, tableIds: tables.map((x) => x.id) }); toast.success(t("Combination created")); onDone(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={t("Combine tables")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} onClick={go}>{t("Create")}</Button></>}>
      <div className="space-y-3 pt-1">
        <p className="text-sm text-ink-2">{tables.map((x) => x.name).join(" + ")}</p>
        <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Total seats")}><Input type="number" min={2} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></Field><Field label={t("Used from party size")} hint={t("Smaller parties get a single table first.")}><Input type="number" min={1} value={min} onChange={(e) => setMin(Number(e.target.value))} /></Field></div>
        {err && <Notice tone="bad">{err.message}</Notice>}
      </div>
    </Dialog>
  );
}

function FloorDialog({ mode, floor, locationId, onClose, onDone }: { mode: null | "new" | "edit"; floor: { id: string; name: string; width: number; height: number } | undefined; locationId: string; onClose: () => void; onDone: (id?: string) => void }) {
  const { t } = useI18n(); const { toast, confirm } = useFeedback();
  const [name, setName] = useState(""); const [w, setW] = useState(1000); const [h, setH] = useState(640); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (mode === "edit" && floor) { setName(floor.name); setW(floor.width); setH(floor.height); } else if (mode === "new") { setName(""); setW(1000); setH(640); } setErr(null); }, [mode, floor]);
  async function save() {
    setBusy(true); setErr(null);
    try { if (mode === "new") { const r = await api.post("/api/v1/floor/floors", { locationId, name, width: w, height: h }); toast.success(t("Floor created")); onDone(r.id); } else { await api.patch(`/api/v1/floor/floors/${floor!.id}`, { name, width: w, height: h }); toast.success(t("Floor updated")); onDone(); } } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  async function remove() {
    if (!floor || !(await confirm({ title: t("Delete floor {name}?", { name: floor.name }), message: t("Only empty floors can be deleted."), tone: "danger", confirmLabel: t("Delete") }))) return;
    try { await api.del(`/api/v1/floor/floors/${floor.id}`); toast.success(t("Floor deleted")); onDone(); } catch (e) { toast.error(e); }
  }
  const fe = err?.fields ?? {};
  return (
    <Dialog open={!!mode} onClose={onClose} size="sm" title={mode === "new" ? t("New floor") : t("Edit floor")}
      footer={<>{mode === "edit" && <Button variant="ghost" className="!text-bad me-auto" onClick={remove}>{t("Delete floor")}</Button>}<Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} onClick={save}>{t("Save")}</Button></>}>
      <div className="space-y-3 pt-1"><Field label={t("Name")} error={fe.name}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Terrace, Rooftop, Salon…")} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Canvas width")} error={fe.width}><Input type="number" min={400} max={3000} step={50} value={w} onChange={(e) => setW(Number(e.target.value))} /></Field><Field label={t("Canvas height")} error={fe.height}><Input type="number" min={300} max={2000} step={50} value={h} onChange={(e) => setH(Number(e.target.value))} /></Field></div>
        {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}</div>
    </Dialog>
  );
}

function SectionDialog({ open, onClose, locationId, onDone }: { open: boolean; onClose: () => void; locationId: string; onDone: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const [name, setName] = useState(""); const [kind, setKind] = useState("indoor"); const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (open) { setName(""); setKind("indoor"); setErr(null); } }, [open]);
  async function go() { try { await api.post("/api/v1/floor/sections", { locationId, name, kind }); toast.success(t("Section added")); onDone(); } catch (e) { setErr(e as ApiError); } }
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={t("New dining area")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" onClick={go}>{t("Add")}</Button></>}>
      <div className="space-y-3 pt-1"><Field label={t("Name")} error={err?.fields.name}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Terrace, Bar, Private dining…")} /></Field>
        <Field label={t("Type")}><Select value={kind} onChange={(e) => setKind(e.target.value)}>{["indoor", "outdoor", "terrace", "bar", "private"].map((k) => <option key={k} value={k}>{t(k)}</option>)}</Select></Field>
        {err && !err.fields.name && <Notice tone="bad">{err.message}</Notice>}</div>
    </Dialog>
  );
}
void useMemo;
