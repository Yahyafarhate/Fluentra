"use client";
import { useState } from "react";
import { Badge, Button, Field, Input, Loading, Modal, Notice, Select } from "@/components/ui";
import { AdminShell, DataTable, type OutletLite } from "@/components/admin";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

interface Emp { id: string; name: string; role: string; email: string | null; outletIds: string[] | null; active: boolean; hasPin: boolean; hasPassword: boolean; lockedUntil: string | null }
const ROLES = ["owner", "manager", "supervisor", "cashier", "server", "bartender", "kitchen"];

export default function StaffAdmin() {
  const t = useT();
  return <AdminShell title={t("Staff")}>{(me) => <Inner myRole={me.role} />}</AdminShell>;
}
function Inner({ myRole }: { myRole: string }) {
  const t = useT();
  const { data, loading, reload } = useApi<Emp[]>("/employees"); const outlets = useApi<OutletLite[]>("/outlets");
  const [edit, setEdit] = useState<(Partial<Emp> & { pin?: string; password?: string }) | null>(null); const [err, setErr] = useState<string | null>(null);
  const assignable = myRole === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
  const save = async () => { setErr(null); const b = edit!; try {
    const body = { name: b.name, role: b.role, email: b.email || null, pin: b.pin || undefined, password: b.password || undefined, outletIds: b.outletIds ?? null };
    if (b.id) await api("PATCH", `/employees/${b.id}`, { ...body, email: b.email || undefined }); else await api("POST", "/employees", body);
    setEdit(null); reload(); } catch (e) { setErr((e as ApiError).message); } };
  return (
    <div className="grid gap-4">
      <div><Button onClick={() => { setEdit({ role: "server", active: true, outletIds: null }); setErr(null); }}>+ {t("New employee")}</Button></div>
      {loading ? <Loading /> : <DataTable rows={(data ?? []).map((e) => ({ ...e, access: [e.hasPin ? "POS" : "", e.hasPassword ? t("Back office") : ""].filter(Boolean).join(" + ") || "—", locked: !!e.lockedUntil && new Date(e.lockedUntil) > new Date(), outlets: e.outletIds ? e.outletIds.length : t("all") }))} columns={["name", "role", "email", "access", "outlets", "active", "locked"]} onRow={(r) => { setEdit(data!.find((x) => x.id === r.id)!); setErr(null); }} />}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t("Edit employee") : t("New employee")}
        footer={<>{edit?.id && <><Button variant="ghost" onClick={async () => { await api("PATCH", `/employees/${edit.id}`, { unlock: true }); setEdit(null); reload(); }}>{t("Unlock")}</Button><Button variant="ghost" className="text-bad" onClick={async () => { try { await api("PATCH", `/employees/${edit.id}`, { active: !edit.active }); setEdit(null); reload(); } catch (e) { setErr((e as ApiError).message); } }}>{edit.active ? t("Deactivate") : t("Reactivate")}</Button></>}<Button variant="ghost" onClick={() => setEdit(null)}>{t("Cancel")}</Button><Button disabled={!edit?.name} onClick={save}>{t("Save")}</Button></>}>
        {edit && <div className="grid gap-3">
          <Field label={t("Name")}><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label={t("Role")}><Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{assignable.map((r) => <option key={r} value={r}>{t(r)}</option>)}</Select></Field>
          <Field label={edit.id ? t("New PIN (leave empty to keep)") : t("POS PIN (4-8 digits)")} hint={t("Easy PINs (1234, 1111…) are refused.")}><Input inputMode="numeric" value={edit.pin ?? ""} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} autoComplete="off" /></Field>
          <Field label={t("Email (back office)")}><Input type="email" value={edit.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          <Field label={edit.id ? t("New password (leave empty to keep)") : t("Password (back office)")}><Input type="password" value={edit.password ?? ""} onChange={(e) => setEdit({ ...edit, password: e.target.value })} autoComplete="new-password" /></Field>
          <div><div className="text-sm font-medium text-ink-2 mb-1">{t("Outlets")}</div><div className="flex flex-wrap gap-2"><button onClick={() => setEdit({ ...edit, outletIds: null })} className={`px-3 h-9 rounded-full border text-sm ${!edit.outletIds ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{t("All outlets")}</button>{outlets.data?.map((o) => { const on = edit.outletIds?.includes(o.id); return <button key={o.id} onClick={() => setEdit({ ...edit, outletIds: on ? edit.outletIds!.filter((x) => x !== o.id) : [...(edit.outletIds ?? []), o.id] })} className={`px-3 h-9 rounded-full border text-sm ${on ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{o.name}</button>; })}</div></div>
          {edit.id && !edit.active && <Badge tone="bad">{t("Deactivated")}</Badge>}
          {err && <Notice tone="bad">{err}</Notice>}
        </div>}
      </Modal>
    </div>
  );
}
