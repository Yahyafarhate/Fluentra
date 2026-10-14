"use client";
import { Badge, Card, CardHeader, ErrorState, Notice, PageHeader, Skeleton, Stat } from "@/components/ui";
import { HBar } from "@/components/charts";
import { useI18n } from "@/lib/i18n/client";
import { useApi } from "@/lib/client/hooks";

export default function AdminOverview() {
  const { t, fmt } = useI18n();
  const { data, error, reload } = useApi<any>("/api/admin/overview"); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const { totals: x, health: h } = data;
  return (
    <>
      <PageHeader title="Platform overview" subtitle="Tenants, usage and system health" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat icon="building" label="Organizations" value={x.orgs} sub={`${x.active} active · ${x.trials} trial`} />
        <Stat icon="alert" label="Suspended / past due" value={`${x.suspended} / ${x.pastDue}`} tone={x.suspended || x.pastDue ? "bad" : undefined} />
        <Stat icon="pin" label="Locations" value={x.locations} sub={`${x.users} users`} />
        <Stat icon="calendar" label="Reservations this month" value={fmt.number(x.reservationsMonth)} />
        <Stat icon="card" label="MRR (list price)" value={`${fmt.number(x.mrrMad)} MAD`} sub="Active orgs × plan price. No payments are processed." />
        <Stat icon="message" label="Failed messages (24h)" value={x.failedNotifications24h} tone={x.failedNotifications24h ? "bad" : "ok"} />
      </div>
      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <Card><CardHeader title="Plan distribution" /><HBar rows={data.byPlan.map((p: { name: string; orgs: number }) => ({ label: p.name, value: p.orgs }))} /></Card>
        <Card>
          <CardHeader title="System health" />
          <ul className="space-y-3 text-sm">
            <li className="flex justify-between"><span>Database</span><Badge tone={h.database.ok ? "ok" : "bad"} dot>{h.database.ok ? "Up" : "Down"}</Badge></li>
            <li className="flex justify-between"><span>Background jobs</span><span className="flex items-center gap-2"><span className="text-muted text-xs">{h.jobs.queued} queued · {h.jobs.running} running · {h.jobs.failed} failed{h.jobs.oldestQueuedAgeSec ? ` · oldest ${h.jobs.oldestQueuedAgeSec}s` : ""}</span><Badge tone={h.jobs.ok ? "ok" : "bad"} dot>{h.jobs.ok ? "Healthy" : "Attention"}</Badge></span></li>
            {Object.entries(h.integrations).map(([k, v]: [string, any]) => <li key={k} className="flex justify-between gap-4"><span className="capitalize">{k}</span><span className="flex items-center gap-2 text-end"><span className="text-xs text-muted max-w-64 truncate" title={v.message}>{v.provider}</span><Badge tone={v.state === "connected" ? "ok" : v.state === "simulated" ? "gold" : "warn"} dot>{v.state.replace("_", " ")}</Badge></span></li>)}
            <li className="flex justify-between"><span>Environment</span><span className="text-xs text-muted">{h.environment.nodeEnv}{h.environment.simulatedNotifications ? " · simulated notifications" : ""}</span></li>
          </ul>
          {h.environment.simulatedNotifications && <div className="mt-4"><Notice tone="gold">Simulation mode is ON — messages are recorded but not sent. Disable DEV_SIMULATE_NOTIFICATIONS in production.</Notice></div>}
        </Card>
      </div>
      <p className="text-xs text-muted mt-6">Server time {fmt.date(h.database.serverTime, { dateStyle: "medium", timeStyle: "medium" })}</p>
    </>
  );
}
