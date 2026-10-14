"use client";
import { useRef, useState } from "react";
import { Badge, Button, Field, Input, Loading, Modal, Notice, Select, Tabs, Textarea } from "@/components/ui";
import { AdminShell, DataTable, OutletPicker, useOutlet } from "@/components/admin";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { money, pct } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Product { id: string; name: string; categoryId: string | null; priceCents: number; taxRateId: string; stationKind: string; defaultCourse: number; allergens: string[]; available: boolean; active: boolean; sku: string | null }
interface Cat { id: string; name: string; active: boolean }
interface Group { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; priceDeltaCents: number }> }
interface Tax { id: string; name: string; rateBps: number }
type Tab = "products" | "categories" | "modifiers" | "discounts" | "tax" | "io";
const cents = (s: string) => Math.round(Number(s.replace(",", ".")) * 100);

export default function MenuAdmin() {
  const t = useT();
  return <AdminShell title={t("Menu")}>{(me) => <Inner cur={me.org.currency} canTax={me.permissions.includes("settings.manage")} />}</AdminShell>;
}

function Inner({ cur, canTax }: { cur: string; canTax: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("products");
  const prods = useApi<Product[]>("/menu/products"); const cats = useApi<Cat[]>("/menu/categories"); const groups = useApi<Group[]>("/menu/modifier-groups"); const taxes = useApi<Tax[]>("/menu/tax-rates"); const discounts = useApi<Array<Record<string, unknown>>>("/discounts");
  const { outlets, outlet, setOutletId } = useOutlet();
  const [edit, setEdit] = useState<Partial<Product> & { price?: string; groupIds?: string[]; allergensText?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<null | "cat" | "group" | "disc" | "tax" | "override">(null);
  const [f, setF] = useState<Record<string, string>>({}); const [mods, setMods] = useState([{ name: "", price: "0" }]);
  const [ov, setOv] = useState<Product | null>(null); const [ovPrice, setOvPrice] = useState(""); const [ovAvail, setOvAvail] = useState(true);
  const file = useRef<HTMLInputElement>(null); const [ioMsg, setIoMsg] = useState<string | null>(null);

  const guard = async (fn: () => Promise<unknown>, done?: () => void) => { setErr(null); try { await fn(); done?.(); } catch (e) { setErr((e as ApiError).message + ((e as ApiError).details ? " — " + JSON.stringify((e as ApiError).details) : "")); } };

  const saveProduct = () => guard(async () => {
    const p = edit!;
    const body = { name: p.name, priceCents: cents(p.price ?? "0"), taxRateId: p.taxRateId, categoryId: p.categoryId || null, stationKind: p.stationKind ?? "kitchen", defaultCourse: p.defaultCourse ?? 1, allergens: (p.allergensText ?? "").split(",").map((s) => s.trim()).filter(Boolean), modifierGroupIds: p.groupIds ?? [], sku: p.sku || null };
    if (p.id) await api("PATCH", `/menu/products/${p.id}`, body); else await api("POST", "/menu/products", body);
  }, () => { setEdit(null); prods.reload(); });

  return (
    <div className="grid gap-4">
      <div className="flex gap-3 items-center flex-wrap"><Tabs value={tab} onChange={setTab} tabs={[{ id: "products", label: t("Products") }, { id: "categories", label: t("Categories") }, { id: "modifiers", label: t("Modifiers") }, { id: "discounts", label: t("Discounts") }, { id: "tax", label: t("Tax rates") }, { id: "io", label: t("Import / export") }]} /></div>
      {err && <Notice tone="bad">{err}</Notice>}

      {tab === "products" && (<>
        <div className="flex justify-between items-center gap-2 flex-wrap"><Button onClick={() => setEdit({ taxRateId: taxes.data?.find((x) => x.rateBps === 1000)?.id ?? taxes.data?.[0]?.id, stationKind: "kitchen", defaultCourse: 1, groupIds: [] })}>+ {t("New product")}</Button><OutletPicker outlets={outlets} value={outlet?.id ?? ""} onChange={setOutletId} /></div>
        {prods.loading ? <Loading /> : <DataTable rows={(prods.data ?? []).map((p) => ({ ...p, category: cats.data?.find((c) => c.id === p.categoryId)?.name ?? "—", tax: pct(taxes.data?.find((x) => x.id === p.taxRateId)?.rateBps ?? 0) }))} currency={cur} columns={["name", "category", "priceCents", "tax", "stationKind", "available", "active"]}
          onRow={(r) => { const p = prods.data!.find((x) => x.id === r.id)!; setEdit({ ...p, price: (p.priceCents / 100).toFixed(2), allergensText: p.allergens.join(", "), groupIds: [] }); }} />}
        <p className="text-xs text-muted">{t("Click a row to edit. Price changes are recorded in the audit log with the previous price; open orders keep the price they were sold at.")}</p>
      </>)}

      {tab === "categories" && (<><Button onClick={() => { setF({ name: "" }); setForm("cat"); }}>+ {t("New category")}</Button><DataTable rows={cats.data as never} columns={["name", "active"]} /></>)}
      {tab === "modifiers" && (<><Button onClick={() => { setF({ name: "", min: "0", max: "1" }); setMods([{ name: "", price: "0" }]); setForm("group"); }}>+ {t("New modifier group")}</Button>
        <div className="grid gap-3 md:grid-cols-2">{groups.data?.map((g) => <div key={g.id} className="rounded-2xl border border-line bg-surface p-4"><div className="font-semibold">{g.name} <span className="text-xs text-muted font-normal">min {g.minSelect} · max {g.maxSelect}</span></div><div className="flex flex-wrap gap-1 mt-2">{g.modifiers.map((m) => <Badge key={m.id}>{m.name}{m.priceDeltaCents ? ` (${m.priceDeltaCents > 0 ? "+" : ""}${money(m.priceDeltaCents, cur)})` : ""}</Badge>)}</div></div>)}</div></>)}
      {tab === "discounts" && (<><Button onClick={() => { setF({ name: "", kind: "percent", value: "10", thr: "10" }); setForm("disc"); }}>+ {t("New discount")}</Button><DataTable rows={discounts.data} currency={cur} columns={["name", "kind", "value", "approvalThresholdBps"]} /></>)}
      {tab === "tax" && (<>{canTax && <Button onClick={() => { setF({ name: "", rate: "10" }); setForm("tax"); }}>+ {t("New tax rate")}</Button>}<DataTable rows={taxes.data as never} columns={["name", "rateBps"]} /><Notice tone="warn" title={t("Validate with your accountant")}>{t("Default Moroccan VAT rates are provided as a starting point only. Confirm the rates and receipt requirements with a qualified accountant.")}</Notice></>)}

      {tab === "io" && (
        <div className="grid gap-4 max-w-xl">
          <div><h2 className="font-semibold mb-2">{t("Export")}</h2><Button variant="secondary" onClick={async () => { const d = await api("GET", "/menu/export"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })); a.download = "comptoir-menu.json"; a.click(); }}>{t("Download menu (JSON)")}</Button></div>
          <div><h2 className="font-semibold mb-2">{t("Import")}</h2><input ref={file} type="file" accept="application/json" className="hidden" onChange={async (e) => { const fl = e.target.files?.[0]; if (!fl) return; setIoMsg(null); try { const r = await api<{ created: number; updated: number }>("POST", "/menu/import", JSON.parse(await fl.text())); setIoMsg(`${t("Created")}: ${r.created} · ${t("Updated")}: ${r.updated}`); prods.reload(); cats.reload(); } catch (x) { setErr((x as Error).message); } }} />
            <Button variant="secondary" onClick={() => file.current?.click()}>{t("Choose a JSON file")}</Button>{ioMsg && <div className="mt-2"><Notice tone="ok">{ioMsg}</Notice></div>}<p className="text-xs text-muted mt-2">{t("Import updates matching products and creates new ones; it never deletes. Tax rates must already exist.")}</p></div>
        </div>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? t("Edit product") : t("New product")}
        footer={<>{edit?.id && outlet && <Button variant="secondary" className="me-auto" onClick={() => { setOv(edit as Product); setOvPrice(""); setOvAvail(true); setForm("override"); }}>{t("Outlet price / availability…")}</Button>}{edit?.id && <Button variant="ghost" onClick={() => guard(() => api("PATCH", `/menu/products/${edit.id}`, { active: !edit.active }), () => { setEdit(null); prods.reload(); })}>{edit.active === false ? t("Reactivate") : t("Archive")}</Button>}<Button variant="ghost" onClick={() => setEdit(null)}>{t("Cancel")}</Button><Button disabled={!edit?.name || !edit?.price} onClick={saveProduct}>{t("Save")}</Button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Name")} className="sm:col-span-2"><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label={t("Price (tax included if the outlet is set that way)")}><Input inputMode="decimal" value={edit.price ?? ""} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></Field>
          <Field label={t("Tax rate")}><Select value={edit.taxRateId ?? ""} onChange={(e) => setEdit({ ...edit, taxRateId: e.target.value })}>{taxes.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label={t("Category")}><Select value={edit.categoryId ?? ""} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value })}><option value="">—</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label={t("Prepared at")}><Select value={edit.stationKind ?? "kitchen"} onChange={(e) => setEdit({ ...edit, stationKind: e.target.value })}>{["kitchen", "bar", "pastry", "none"].map((k) => <option key={k} value={k}>{t(k)}</option>)}</Select></Field>
          <Field label={t("Default course")}><Select value={edit.defaultCourse ?? 1} onChange={(e) => setEdit({ ...edit, defaultCourse: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          <Field label={t("SKU")}><Input value={edit.sku ?? ""} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
          <Field label={t("Allergens (comma separated)")} className="sm:col-span-2"><Input value={edit.allergensText ?? ""} onChange={(e) => setEdit({ ...edit, allergensText: e.target.value })} placeholder="gluten, nuts, dairy" /></Field>
          <div className="sm:col-span-2"><div className="text-sm font-medium text-ink-2 mb-1">{t("Modifier groups")}{edit.id ? ` (${t("leave empty to keep current")})` : ""}</div><div className="flex flex-wrap gap-2">{groups.data?.map((g) => { const on = edit.groupIds?.includes(g.id); return <button key={g.id} onClick={() => setEdit({ ...edit, groupIds: on ? edit.groupIds!.filter((x) => x !== g.id) : [...(edit.groupIds ?? []), g.id] })} className={`px-3 h-9 rounded-full border text-sm ${on ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{g.name}</button>; })}</div></div>
        </div>}
      </Modal>

      <Modal open={form === "cat"} onClose={() => setForm(null)} title={t("New category")} footer={<><Button variant="ghost" onClick={() => setForm(null)}>{t("Cancel")}</Button><Button disabled={!f.name} onClick={() => guard(() => api("POST", "/menu/categories", { name: f.name }), () => { setForm(null); cats.reload(); })}>{t("Save")}</Button></>}><Field label={t("Name")}><Input value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></Modal>
      <Modal open={form === "group"} onClose={() => setForm(null)} wide title={t("New modifier group")} footer={<><Button variant="ghost" onClick={() => setForm(null)}>{t("Cancel")}</Button><Button disabled={!f.name || mods.every((m) => !m.name)} onClick={() => guard(() => api("POST", "/menu/modifier-groups", { name: f.name, minSelect: Number(f.min), maxSelect: Number(f.max), modifiers: mods.filter((m) => m.name).map((m) => ({ name: m.name, priceDeltaCents: cents(m.price) || 0 })) }), () => { setForm(null); groups.reload(); })}>{t("Save")}</Button></>}>
        <div className="grid gap-3"><Field label={t("Name")}><Input value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Cooking, Size, Extras…" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={t("Minimum choices (0 = optional)")}><Input type="number" min={0} max={10} value={f.min ?? "0"} onChange={(e) => setF({ ...f, min: e.target.value })} /></Field><Field label={t("Maximum choices")}><Input type="number" min={1} max={10} value={f.max ?? "1"} onChange={(e) => setF({ ...f, max: e.target.value })} /></Field></div>
          {mods.map((m, i) => <div key={i} className="grid grid-cols-[1fr_8rem] gap-2"><Input placeholder={t("Option name")} value={m.name} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /><Input inputMode="decimal" placeholder="+0.00" value={m.price} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></div>)}
          <Button variant="secondary" onClick={() => setMods([...mods, { name: "", price: "0" }])}>+ {t("Add an option")}</Button></div></Modal>
      <Modal open={form === "disc"} onClose={() => setForm(null)} title={t("New discount")} footer={<><Button variant="ghost" onClick={() => setForm(null)}>{t("Cancel")}</Button><Button disabled={!f.name || !Number(f.value)} onClick={() => guard(() => api("POST", "/menu/discounts", { name: f.name, kind: f.kind, value: cents(f.value), approvalThresholdBps: Math.round(Number(f.thr || 10) * 100) }), () => { setForm(null); discounts.reload(); })}>{t("Save")}</Button></>}>
        <div className="grid gap-3"><Field label={t("Name")}><Input value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><div className="grid grid-cols-2 gap-3"><Field label={t("Type")}><Select value={f.kind ?? "percent"} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">%</option><option value="amount">{cur}</option></Select></Field><Field label={t("Value")}><Input inputMode="decimal" value={f.value ?? ""} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field></div><Field label={t("Needs supervisor approval above (% of the bill)")}><Input inputMode="decimal" value={f.thr ?? "10"} onChange={(e) => setF({ ...f, thr: e.target.value })} /></Field></div></Modal>
      <Modal open={form === "tax"} onClose={() => setForm(null)} title={t("New tax rate")} footer={<><Button variant="ghost" onClick={() => setForm(null)}>{t("Cancel")}</Button><Button disabled={!f.name} onClick={() => guard(() => api("POST", "/menu/tax-rates", { name: f.name, rateBps: Math.round(Number(f.rate) * 100) }), () => { setForm(null); taxes.reload(); })}>{t("Save")}</Button></>}><div className="grid gap-3"><Field label={t("Name")}><Input value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="%"><Input inputMode="decimal" value={f.rate ?? ""} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field></div></Modal>
      <Modal open={form === "override"} onClose={() => setForm(null)} title={`${t("At")} ${outlet?.name ?? ""} — ${ov?.name ?? ""}`} footer={<><Button variant="ghost" onClick={() => setForm(null)}>{t("Cancel")}</Button><Button onClick={() => guard(() => api("PUT", `/menu/products/${ov!.id}/outlets/${outlet!.id}`, { priceCents: ovPrice ? cents(ovPrice) : null, available: ovAvail }), () => { setForm(null); setEdit(null); })}>{t("Save")}</Button></>}>
        <div className="grid gap-3"><Field label={t("Outlet price (empty = standard price)")}><Input inputMode="decimal" value={ovPrice} onChange={(e) => setOvPrice(e.target.value)} /></Field><label className="flex items-center gap-2"><input type="checkbox" className="size-5" checked={ovAvail} onChange={(e) => setOvAvail(e.target.checked)} />{t("Available at this outlet")}</label></div></Modal>
    </div>
  );
}
void Textarea;
