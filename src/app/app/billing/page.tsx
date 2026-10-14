"use client";
import { useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, ErrorState, Notice, PageHeader, Skeleton, StatusBadge } from "@/components/ui";
import { Meter } from "@/components/charts";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

const FEATURES: Array<[string, string]> = [["crm", "Guest CRM"], ["waitlist", "Waitlist & walk-ins"], ["analytics", "Analytics"], ["analytics_export", "CSV exports"], ["automations", "Custom automations"], ["marketing", "Marketing campaigns"], ["multi_location", "Multi-location"], ["custom_branding", "Custom branding"], ["deposits", "Deposits"], ["forecasting", "Forecasting"], ["api", "API access"]];

export default function BillingPage() {
  const { t, fmt } = useI18n();
  const { can } = useApp();
  const { toast, confirm } = useFeedback();
  const { data, error, reload } = useApi<any>(can("billing.manage") ? "/api/v1/billing" : null);  
  const [busy, setBusy] = useState<string | null>(null);
  if (!can("billing.manage")) return <NoAccess />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const { plan, usage } = data;
  const lim = (n: number | null) => (n == null ? "∞" : n);
  async function choose(id: string, name: string) {
    if (!(await confirm({ title: t("Switch to {plan}?", { plan: name }), message: t("No payment provider is connected: this change is SIMULATED — no charge is made and no invoice is issued. It still applies plan limits and features immediately."), confirmLabel: t("Switch plan (simulated)") }))) return;
    setBusy(id);
    try { await api.post("/api/v1/billing/plan", { planId: id }); toast.success(t("Plan changed (simulated)")); reload(); window.setTimeout(() => window.location.reload(), 500); } catch (e) { toast.error(e); } finally { setBusy(null); }
  }
  return (
    <>
      <PageHeader title={t("Subscription & billing")} subtitle={t("Plan limits are enforced by the server, not just hidden in the interface.")} />
      <div className="space-y-6">
        <Notice tone="gold" title={t("Billing provider: not connected")}>{data.provider.message}</Notice>
        {data.trialExpired && <Notice tone="bad" title={t("Your trial has ended")}>{t("New reservations are blocked until you choose a plan. Existing data is untouched.")}</Notice>}
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-1">
            <CardHeader title={t("Current plan")} action={<StatusBadge status={plan.status} />} />
            <p className="text-3xl font-semibold font-display">{plan.planName}</p>
            {plan.status === "trial" && plan.trialEndsAt && <p className="text-sm text-muted mt-1">{t("Trial ends {date}", { date: fmt.date(plan.trialEndsAt, { dateStyle: "long" }) })}</p>}
            <div className="mt-5 space-y-4 text-sm">
              {([["Locations", usage.locations, plan.maxLocations], ["Team members (incl. invitations)", usage.users, plan.maxUsers], ["Reservations this month", usage.reservationsThisMonth, plan.maxMonthlyReservations]] as const).map(([l, u, m]) => (
                <div key={l}><div className="flex justify-between mb-1"><span>{t(l)}</span><b className="tabular">{u} / {lim(m)}</b></div><Meter value={u} max={m ?? Math.max(u, 1) * 4} tone={m != null && u >= m ? "bad" : "gold"} label={l} /></div>))}
            </div>
          </Card>
          <div className="lg:col-span-2 grid sm:grid-cols-3 gap-4">
            {data.plans.map((p: any) => (  
              <Card key={p.id} className={p.id === plan.planId ? "!border-gold ring-1 ring-gold" : ""}>
                <div className="flex items-center justify-between"><h3 className="text-xl font-semibold">{p.name}</h3>{p.id === plan.planId && <Badge tone="gold">{t("Current")}</Badge>}</div>
                <p className="mt-2"><span className="text-2xl font-semibold tabular">{fmt.number(p.priceMadMonthly)}</span> <span className="text-sm text-muted">MAD / {t("month")}</span></p>
                <ul className="mt-4 space-y-1.5 text-sm">
                  <li>{lim(p.maxLocations)} {t("locations")}</li><li>{lim(p.maxUsers)} {t("team members")}</li><li>{lim(p.maxMonthlyReservations)} {t("reservations / month")}</li>
                  {FEATURES.map(([k, l]) => <li key={k} className={p.features.includes(k) ? "" : "text-muted/60 line-through"}><Icon name={p.features.includes(k) ? "check" : "minus"} size={14} className={`inline me-1.5 ${p.features.includes(k) ? "text-ok" : ""}`} />{t(l)}</li>)}
                </ul>
                <Button className="w-full mt-5" variant={p.id === plan.planId ? "secondary" : "primary"} disabled={p.id === plan.planId || !data.canSelfServe} loading={busy === p.id} onClick={() => choose(p.id, p.name)}>{p.id === plan.planId ? t("Current plan") : data.canSelfServe ? t("Choose {plan}", { plan: p.name }) : t("Contact support")}</Button>
              </Card>))}
          </div>
        </div>
        {data.events.length > 0 && <Card><CardHeader title={t("Subscription history")} /><ul className="text-sm divide-y divide-line">{data.events.map((e: any, i: number) => <li key={i} className="py-2 flex justify-between"><span>{e.type.replace(/_/g, " ")}{e.payload?.to ? ` → ${e.payload.to}` : ""}</span><span className="text-muted">{fmt.date(e.createdAt, { dateStyle: "medium", timeStyle: "short" })}</span></li>)}</ul></Card>}
      </div>
    </>
  );
}
