"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, Notice, Select, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { useApp } from "@/components/app-shell";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

export function PrivacyTab() {
  const { t } = useI18n(); const { toast } = useFeedback();
  const { data, error, reload } = useApi<any>("/api/v1/organization");  
  const [name, setName] = useState(""); const [months, setMonths] = useState(36); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (data) { setName(data.organization.name); setMonths(data.organization.retentionMonths); } }, [data]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-64" />;
  async function save() { setBusy(true); setErr(null); try { await api.patch("/api/v1/organization", { name, retentionMonths: months }); toast.success(t("Saved")); reload(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title={t("Organization")} />
        <div className="space-y-4">
          <Field label={t("Business name")} error={err?.fields.name}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Guest data retention (months)")} error={err?.fields.retentionMonths} hint={t("Guests with no visits or bookings for this long are anonymized automatically (name, contact details and notes are erased; anonymous statistics remain). 6–120 months.")}><Input type="number" min={6} max={120} value={months} onChange={(e) => setMonths(Number(e.target.value))} /></Field>
          <Button variant="primary" loading={busy} onClick={save}>{t("Save")}</Button>
        </div>
      </Card>
      <Card>
        <CardHeader title={t("Privacy controls in Fluentra")} />
        <ul className="text-sm text-ink-2 space-y-2.5 list-disc ps-5">
          <li>{t("Marketing messages require recorded consent per channel; withdrawals are honoured immediately (unsubscribe links, staff toggle).")}</li>
          <li>{t("Guest access and erasure requests are handled from each guest profile (Consent & privacy tab).")}</li>
          <li>{t("Staff see guest data according to their role and assigned locations.")}</li>
          <li>{t("Every export, merge, erasure and settings change is written to the audit log.")}</li>
          <li>{t("Daily backups and restore procedure: see docs/OPERATIONS.md.")}</li>
        </ul>
      </Card>
    </div>
  );
}

export function AuditTab() {
  const { t, fmt } = useI18n();
  const [action, setAction] = useState("");
  const { data, error, loading } = useApi<{ entries: any[] }>(`/api/v1/audit${qs({ action: action || undefined, limit: 200 })}`);  
  if (error) return <ErrorState error={error} />;
  return (
    <Card pad={false}>
      <div className="p-5 pb-3"><CardHeader title={t("Audit log")} subtitle={t("Who did what, and when. Entries cannot be edited or deleted.")} action={<Select value={action} onChange={(e) => setAction(e.target.value)} className="!w-auto" aria-label={t("Filter")}><option value="">{t("All actions")}</option>{["reservation", "customer", "table", "location", "team", "template", "billing", "campaign", "automation", "auth"].map((a) => <option key={a} value={a + "."}>{a}</option>)}</Select>} /></div>
      {loading ? <div className="p-5"><Skeleton className="h-40" /></div> : !data?.entries.length ? <EmptyState icon="shield" title={t("No entries")} /> : (
        <TableWrap><thead><tr><Th>{t("When")}</Th><Th>{t("Who")}</Th><Th>{t("Action")}</Th><Th>{t("Details")}</Th></tr></thead>
          <tbody>{data.entries.map((e) => <tr key={e.id}><Td className="whitespace-nowrap tabular text-xs">{fmt.date(e.createdAt, { dateStyle: "medium", timeStyle: "short" })}</Td><Td className="text-xs">{e.actorLabel}</Td><Td><Badge>{e.action}</Badge></Td><Td className="text-xs text-muted max-w-md truncate">{e.entityType ? `${e.entityType}${e.entityId ? " " + String(e.entityId).slice(0, 8) : ""} · ` : ""}{Object.keys(e.metadata ?? {}).length ? JSON.stringify(e.metadata) : ""}</Td></tr>)}</tbody></TableWrap>)}
    </Card>
  );
}

export function LocationsTab() {
  const { t } = useI18n(); const { toast, confirm } = useFeedback(); const { hasFeature, me } = useApp();
  const { data, error, reload } = useApi<any[]>("/api/v1/locations");  
  const [dlg, setDlg] = useState(false); const [f, setF] = useState({ name: "", city: "" }); const [err, setErr] = useState<ApiError | null>(null);
  const { can } = useApp();
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-48" />;
  async function add() { try { await api.post("/api/v1/locations", { name: f.name, city: f.city || undefined }); toast.success(t("Location created — set up its tables and hours next")); setDlg(false); setF({ name: "", city: "" }); reload(); window.setTimeout(() => window.location.reload(), 600); } catch (e) { setErr(e as ApiError); } }
  async function archive(id: string, name: string) { if (!(await confirm({ title: t("Archive {name}?", { name }), message: t("Online booking stops and the location disappears from menus. Data is kept."), tone: "danger", confirmLabel: t("Archive") }))) return; try { await api.del(`/api/v1/locations/${id}`); toast.success(t("Archived")); reload(); window.setTimeout(() => window.location.reload(), 600); } catch (e) { toast.error(e); } }
  return (
    <Card>
      <CardHeader title={t("Locations")} subtitle={t("Manage several restaurants from one account. Staff can be limited to specific locations.")} action={can("locations.manage") ? <Button variant="primary" icon="plus" onClick={() => { setErr(null); setDlg(true); }}>{t("Add location")}</Button> : undefined} />
      {!hasFeature("multi_location") && <div className="mb-4"><Notice tone="gold">{t("Your plan includes one location. Upgrade to Pro to manage several restaurants.")}</Notice></div>}
      <ul className="divide-y divide-line">{data.map((l) => <li key={l.id} className="py-3 flex items-center gap-3"><div className="flex-1 min-w-0"><p className="font-medium">{l.name}</p><p className="text-xs text-muted">{[l.city, l.timezone].filter(Boolean).join(" · ")} · /book/{l.slug}</p></div>{l.status === "archived" ? <Badge>{t("Archived")}</Badge> : <Badge tone={l.onlineBookingEnabled ? "ok" : "warn"} dot>{l.onlineBookingEnabled ? t("Online booking on") : t("Online booking off")}</Badge>}{l.status === "active" && can("locations.manage") && me.locations.length > 1 && <Button size="sm" variant="ghost" className="!text-bad" onClick={() => archive(l.id, l.name)}>{t("Archive")}</Button>}</li>)}</ul>
      <Dialog open={dlg} onClose={() => setDlg(false)} size="sm" title={t("Add location")} footer={<><Button onClick={() => setDlg(false)}>{t("Cancel")}</Button><Button variant="primary" disabled={!f.name.trim()} onClick={add}>{t("Create")}</Button></>}>
        <div className="space-y-3 pt-1"><Field label={t("Name")} error={err?.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label={t("City")}><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>{err && !err.fields.name && <Notice tone="bad">{err.message}</Notice>}</div>
      </Dialog>
    </Card>
  );
}
