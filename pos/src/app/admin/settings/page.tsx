"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Loading, Notice } from "@/components/ui";
import { AdminShell, OutletPicker, useOutlet } from "@/components/admin";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

interface O { id: string; name: string; code: string; timezone: string; pricesIncludeTax: boolean; serviceChargeBps: number; serviceChargeTaxBps: number; businessDayStartHour: number; idleLockMinutes: number; tableAlertMinutes: number; address: string | null; phone: string | null; taxIdentifier: string | null; receiptHeader: string | null; receiptFooter: string | null; fluentraLocationId: string | null }

export default function Settings() { const t = useT(); return <AdminShell title={t("Outlet settings")}>{() => <Inner />}</AdminShell>; }
function Inner() {
  const t = useT();
  const { outlets, outlet, setOutletId } = useOutlet();
  const { data, loading, reload } = useApi<O[]>("/outlets");
  const cur = data?.find((o) => o.id === outlet?.id);
  const [f, setF] = useState<Record<string, string | boolean>>({}); const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null); const [newName, setNewName] = useState("");
  useEffect(() => { if (cur) setF({ name: cur.name, timezone: cur.timezone, pricesIncludeTax: cur.pricesIncludeTax, service: String(cur.serviceChargeBps / 100), serviceTax: String(cur.serviceChargeTaxBps / 100), dayStart: String(cur.businessDayStartHour), idle: String(cur.idleLockMinutes), alert: String(cur.tableAlertMinutes), address: cur.address ?? "", phone: cur.phone ?? "", taxId: cur.taxIdentifier ?? "", header: cur.receiptHeader ?? "", footer: cur.receiptFooter ?? "", fl: cur.fluentraLocationId ?? "" }); }, [cur?.id, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setMsg(null);
    try {
      await api("PATCH", `/outlets/${cur!.id}`, { name: f.name, timezone: f.timezone, pricesIncludeTax: f.pricesIncludeTax, serviceChargeBps: Math.round(Number(f.service) * 100), serviceChargeTaxBps: Math.round(Number(f.serviceTax) * 100), businessDayStartHour: Number(f.dayStart), idleLockMinutes: Number(f.idle), tableAlertMinutes: Number(f.alert), address: f.address || null, phone: f.phone || null, taxIdentifier: f.taxId || null, receiptHeader: f.header || null, receiptFooter: f.footer || null, fluentraLocationId: f.fl || null });
      setMsg({ tone: "ok", text: t("Saved") }); reload();
    } catch (e) { setMsg({ tone: "bad", text: (e as ApiError).message }); }
  };
  if (loading || !cur) return <Loading />;
  return (
    <div className="grid gap-4 max-w-3xl">
      <div className="flex gap-3 items-center flex-wrap"><OutletPicker outlets={outlets} value={cur.id} onChange={setOutletId} /><span className="text-sm text-ink-2">{t("Terminal code")}: <Badge tone="gold" className="font-mono text-base tracking-widest">{cur.code}</Badge></span></div>
      <Card className="grid sm:grid-cols-2 gap-3">
        <Field label={t("Outlet name")}><Input value={String(f.name ?? "")} onChange={set("name")} /></Field>
        <Field label={t("Time zone")}><Input value={String(f.timezone ?? "")} onChange={set("timezone")} /></Field>
        <Field label={t("Address")}><Input value={String(f.address ?? "")} onChange={set("address")} /></Field>
        <Field label={t("Phone")}><Input value={String(f.phone ?? "")} onChange={set("phone")} /></Field>
        <Field label={t("Tax identifier (ICE / IF)")} hint={t("Printed on receipts — confirm requirements with your accountant")}><Input value={String(f.taxId ?? "")} onChange={set("taxId")} /></Field>
        <Field label={t("Fluentra location id")} hint={t("Maps this outlet to its Fluentra location for the sync")}><Input value={String(f.fl ?? "")} onChange={set("fl")} /></Field>
        <div className="sm:col-span-2 rounded-xl bg-canvas p-3 grid sm:grid-cols-3 gap-3 items-end">
          <label className="flex items-center gap-2 sm:col-span-3"><input type="checkbox" className="size-5" checked={!!f.pricesIncludeTax} onChange={(e) => setF({ ...f, pricesIncludeTax: e.target.checked })} />{t("Menu prices include tax (TTC)")}</label>
          <Field label={t("Service charge %")}><Input inputMode="decimal" value={String(f.service ?? "0")} onChange={set("service")} /></Field>
          <Field label={t("Tax rate on the service charge %")}><Input inputMode="decimal" value={String(f.serviceTax ?? "0")} onChange={set("serviceTax")} /></Field>
          <Field label={t("Business day starts at (hour)")}><Input type="number" min={0} max={12} value={String(f.dayStart ?? "5")} onChange={set("dayStart")} /></Field>
        </div>
        <Field label={t("Auto-lock after (minutes idle)")}><Input type="number" min={1} max={480} value={String(f.idle ?? "15")} onChange={set("idle")} /></Field>
        <Field label={t("Table alert after (minutes)")}><Input type="number" min={5} max={600} value={String(f.alert ?? "90")} onChange={set("alert")} /></Field>
        <Field label={t("Receipt header")}><Input value={String(f.header ?? "")} onChange={set("header")} /></Field>
        <Field label={t("Receipt footer")}><Input value={String(f.footer ?? "")} onChange={set("footer")} /></Field>
        {msg && <div className="sm:col-span-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
        <div className="sm:col-span-2"><Button onClick={save}>{t("Save")}</Button></div>
      </Card>
      <Card className="flex gap-2 items-end"><Field label={t("Add an outlet")} className="flex-1"><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></Field><Button disabled={newName.length < 2} onClick={async () => { await api("POST", "/outlets", { name: newName }); setNewName(""); reload(); window.location.reload(); }}>{t("Create")}</Button></Card>
    </div>
  );
}
