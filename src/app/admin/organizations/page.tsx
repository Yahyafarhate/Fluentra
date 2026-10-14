"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, StatusBadge, TableWrap, Td, Th } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi, useDebounced } from "@/lib/client/hooks";

export default function OrgsPage() {
  const { fmt } = useI18n(); const router = useRouter(); const { toast } = useFeedback();
  const [q, setQ] = useState(""); const dq = useDebounced(q);
  const { data, error, loading, reload } = useApi<{ organizations: any[] }>(`/api/admin/organizations${qs({ q: dq || undefined })}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dlg, setDlg] = useState(false); const [f, setF] = useState({ name: "", restaurantName: "", city: "", planId: "pro", trialDays: 14, ownerName: "", ownerEmail: "", ownerPassword: "" }); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  async function create() { setBusy(true); setErr(null); try { const r = await api.post("/api/admin/organizations", { ...f, city: f.city || undefined }); toast.success("Organization created"); setDlg(false); router.push(`/admin/organizations/${r.id}`); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }
  const fe = err?.fields ?? {};
  return (
    <>
      <PageHeader title="Organizations" subtitle="Tenant accounts" actions={<Button variant="primary" icon="plus" onClick={() => { setErr(null); setDlg(true); }}>New organization</Button>} />
      <div className="relative max-w-sm mb-4"><Icon name="search" size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted" /><Input className="!ps-9" placeholder="Search by name or slug…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <Skeleton className="h-64" />}
      {data && data.organizations.length === 0 && <EmptyState icon="building" title="No organizations match" />}
      {data && data.organizations.length > 0 && (
        <TableWrap><thead><tr><Th>Organization</Th><Th>Status</Th><Th>Plan</Th><Th className="text-end">Locations</Th><Th className="text-end">Users</Th><Th className="text-end">Reservations / month</Th><Th>Last activity</Th></tr></thead>
          <tbody>{data.organizations.map((o) => <tr key={o.id} className="hover:bg-canvas"><Td><Link href={`/admin/organizations/${o.id}`} className="font-medium hover:underline">{o.name}</Link><p className="text-xs text-muted">{o.slug}</p></Td><Td><StatusBadge status={o.status} />{o.status === "trial" && o.trialEndsAt && <p className="text-xs text-muted mt-0.5">ends {fmt.date(o.trialEndsAt, { day: "numeric", month: "short" })}</p>}</Td><Td><Badge tone={o.planId === "enterprise" ? "violet" : o.planId === "pro" ? "gold" : "neutral"}>{o.planId}</Badge></Td><Td className="text-end tabular">{o.locations}</Td><Td className="text-end tabular">{o.users}</Td><Td className="text-end tabular">{o.reservationsThisMonth}</Td><Td className="text-xs text-muted">{o.lastActivity ? fmt.date(o.lastActivity, { dateStyle: "medium" }) : "—"}</Td></tr>)}</tbody></TableWrap>
      )}
      <Dialog open={dlg} onClose={() => setDlg(false)} size="lg" title="New organization" description="Creates the tenant, its first restaurant and an owner account." footer={<><Button onClick={() => setDlg(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create</Button></>}>
        <div className="grid sm:grid-cols-2 gap-4 pt-1">
          <Field label="Business name" error={fe.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="First restaurant" error={fe.restaurantName}><Input value={f.restaurantName} onChange={(e) => setF({ ...f, restaurantName: e.target.value })} /></Field>
          <Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <Field label="Plan"><Select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></Select></Field>
          <Field label="Trial (days, 0 = active now)"><Input type="number" min={0} max={120} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: Number(e.target.value) })} /></Field>
          <Field label="Owner name" error={fe.ownerName}><Input value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
          <Field label="Owner email" error={fe.ownerEmail}><Input type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
          <Field label="Initial password" error={fe.ownerPassword} hint="Share securely; the owner should change it."><Input type="password" value={f.ownerPassword} onChange={(e) => setF({ ...f, ownerPassword: e.target.value })} autoComplete="new-password" /></Field>
          {err && !Object.keys(fe).length && <div className="sm:col-span-2"><Notice tone="bad">{err.message}</Notice></div>}
        </div>
      </Dialog>
    </>
  );
}
