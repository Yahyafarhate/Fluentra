"use client";
import { use, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, Stat, StatusBadge, TableWrap, Td, Th, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

export default function OrgDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { fmt } = useI18n(); const { toast } = useFeedback();
  const { data, error, reload } = useApi<any>(`/api/admin/organizations/${id}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [plan, setPlan] = useState(""); const [days, setDays] = useState(7); const [sus, setSus] = useState(false); const [reason, setReason] = useState("");
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const o = data.org;
  async function patch(body: object, ok: string) { try { await api.patch(`/api/admin/organizations/${id}`, body); toast.success(ok); reload(); } catch (e) { toast.error(e); } }
  async function suspend() {
    if (!reason.trim()) return;
    try { await api.post(`/api/admin/organizations/${id}/suspend`, { reason }); toast.success("Account suspended"); setSus(false); setReason(""); reload(); } catch (e) { toast.error(e); }
  }
  async function reactivate() { try { await api.post(`/api/admin/organizations/${id}/reactivate`); toast.success("Account reactivated"); reload(); } catch (e) { toast.error(e); } }
  return (
    <>
      <Link href="/admin/organizations" className="text-sm text-muted hover:text-ink inline-flex items-center gap-1 mb-3"><Icon name="chevronLeft" size={14} />Organizations</Link>
      <PageHeader title={<span className="inline-flex items-center gap-3">{o.name}<StatusBadge status={o.status} /></span>} subtitle={`${o.slug} · created ${fmt.date(o.createdAt, { dateStyle: "medium" })}`} />
      {o.status === "suspended" && <div className="mb-6"><Notice tone="bad" title="Suspended" action={<Button variant="primary" onClick={reactivate}>Reactivate</Button>}>{o.suspendedReason} — {o.suspendedAt && fmt.date(o.suspendedAt, { dateStyle: "medium" })}. All data is retained.</Notice></div>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6"><Stat label="Reservations (all time)" value={data.usage.reservationsTotal} /><Stat label="This month" value={data.usage.reservationsMonth} /><Stat label="Guests" value={data.usage.customers} /><Stat label="Messages" value={data.usage.notifications} /></div>
      <div className="grid lg:grid-cols-2 gap-6">
        <Card><CardHeader title="Plan & trial" subtitle={`Current: ${o.planName} (${o.planId})`} />
          <div className="space-y-4">
            <div className="flex gap-2 items-end"><Field label="Change plan" className="flex-1"><Select value={plan || o.planId} onChange={(e) => setPlan(e.target.value)}><option value="trial">Trial</option><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></Select></Field><Button variant="primary" disabled={!plan || plan === o.planId} onClick={() => patch({ planId: plan }, "Plan updated")}>Apply</Button></div>
            <div className="flex gap-2 items-end"><Field label="Extend trial (days)" className="flex-1"><Input type="number" min={1} max={120} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field><Button onClick={() => patch({ extendTrialDays: days }, "Trial extended")}>Extend</Button></div>
            {o.trialEndsAt && <p className="text-xs text-muted">Trial ends {fmt.date(o.trialEndsAt, { dateStyle: "medium" })}</p>}
            {o.status !== "suspended" && <div className="flex gap-2 flex-wrap"><Button onClick={() => patch({ status: "active" }, "Marked active")} disabled={o.status === "active"}>Mark active</Button><Button onClick={() => patch({ status: "past_due" }, "Marked past due")} disabled={o.status === "past_due"}>Mark past due</Button><Button variant="danger" className="ms-auto" onClick={() => setSus(true)}>Suspend…</Button></div>}
            <p className="text-xs text-muted">No billing provider is connected: plan changes are administrative records only.</p>
          </div>
        </Card>
        <Card><CardHeader title="Locations" /><ul className="divide-y divide-line text-sm">{data.locations.map((l: any) => <li key={l.id} className="py-2 flex justify-between"><span>{l.name} <span className="text-muted">/book/{l.slug}</span></span><Badge tone={l.status === "active" ? "ok" : "neutral"}>{l.status}</Badge></li>)}</ul></Card>
        <Card className="lg:col-span-2" pad={false}><div className="p-5 pb-3"><CardHeader title="Members (read-only support view)" /></div>
          <TableWrap><thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Last login</Th></tr></thead><tbody>{data.members.map((m: any) => <tr key={m.id}><Td>{m.name}</Td><Td className="text-xs">{m.email}</Td><Td><Badge>{m.role}</Badge>{m.status === "disabled" && <Badge tone="bad" className="ms-1">disabled</Badge>}</Td><Td className="text-xs text-muted">{m.lastLoginAt ? fmt.date(m.lastLoginAt, { dateStyle: "medium", timeStyle: "short" }) : "never"}</Td></tr>)}</tbody></TableWrap></Card>
        <Card><CardHeader title="Failed messages" />{data.failedNotifications.length ? <ul className="text-sm space-y-2">{data.failedNotifications.map((n: any) => <li key={n.id}><b>{n.templateKey}</b> via {n.channel}<p className="text-xs text-bad">{n.error}</p></li>)}</ul> : <p className="text-sm text-muted">None.</p>}</Card>
        <Card><CardHeader title="Recent audit entries" /><ul className="text-xs space-y-1.5 max-h-72 overflow-y-auto scroll-thin">{data.audit.map((a: any) => <li key={a.id} className="flex justify-between gap-3"><span><Badge>{a.action}</Badge> <span className="text-muted">{a.actorLabel}</span></span><span className="text-muted whitespace-nowrap">{fmt.date(a.createdAt, { dateStyle: "short", timeStyle: "short" })}</span></li>)}</ul></Card>
      </div>
      <Dialog open={sus} onClose={() => setSus(false)} size="sm" title={`Suspend ${o.name}?`} footer={<><Button onClick={() => setSus(false)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={suspend}>Suspend account</Button></>}>
        <div className="space-y-3 pt-1"><Notice tone="warn">Members are signed out immediately and the public booking page goes offline. Nothing is deleted; you can reactivate at any time.</Notice>
          <Field label="Reason (recorded in the audit log)"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      </Dialog>
    </>
  );
}
