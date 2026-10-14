"use client";
import { Badge, Card, ErrorState, Loading } from "@/components/ui";
import { AdminShell, Bars, DataTable, Kpi, OutletPicker, RangePicker, useOutlet, useRange } from "@/components/admin";
import { useApi } from "@/lib/client/hooks";
import { money } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Summary { current: { orders: number; covers: number; grossCents: number; discountCents: number; serviceChargeCents: number; taxCents: number; netSalesCents: number; totalCents: number; tipsCents: number; avgCheckCents: number; avgPerCoverCents: number; refunds: { count: number; amountCents: number }; netOfRefundsCents: number; voids: { itemCount: number; itemAmountCents: number; orderCount: number } }; previous: { from: string; to: string; totalCents: number }; changePct: { totalCents: number | null; orders: number | null; covers: number | null } }

export default function Dashboard() {
  const t = useT();
  const { outlets, outlet, setOutletId } = useOutlet();
  const [r, setR] = useRange(7);
  return (
    <AdminShell title={t("Dashboard")}>{(me) => {
      const q = `from=${r.from}&to=${r.to}${outlet ? `&outletId=${outlet.id}` : ""}`;
      return <Inner q={q} r={r} setR={setR} outlets={outlets} outlet={outlet} setOutletId={setOutletId} cur={me.org.currency} />;
    }}</AdminShell>
  );
}

function Inner({ q, r, setR, outlets, outlet, setOutletId, cur }: { q: string; r: { from: string; to: string }; setR: (f: string, t: string) => void; outlets: ReturnType<typeof useOutlet>["outlets"]; outlet: ReturnType<typeof useOutlet>["outlet"]; setOutletId: (s: string) => void; cur: string }) {
  const t = useT();
  const sum = useApi<Summary>(outlet ? `/reports/summary?${q}` : null);
  const byDay = useApi<Array<{ date: string; totalCents: number }>>(outlet ? `/reports/by-day?${q}` : null);
  const byHour = useApi<Array<{ hour: number; totalCents: number }>>(outlet ? `/reports/by-hour?${q}` : null);
  const prod = useApi<Array<Record<string, unknown>>>(outlet ? `/reports/by-product?${q}` : null);
  const pay = useApi<Array<Record<string, unknown>>>(outlet ? `/reports/payment-methods?${q}` : null);
  const s = sum.data?.current;
  const ch = (v: number | null | undefined) => (v === null || v === undefined ? t("no previous data") : `${v > 0 ? "+" : ""}${v}% ${t("vs previous period")}`);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-3 items-center justify-between"><RangePicker from={r.from} to={r.to} onChange={setR} /><OutletPicker outlets={outlets} value={outlet?.id ?? ""} onChange={setOutletId} /></div>
      {sum.loading ? <Loading /> : sum.error ? <ErrorState error={sum.error} retry={sum.reload} /> : s && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label={t("Total billed")} value={money(s.totalCents, cur)} sub={ch(sum.data?.changePct.totalCents)} />
            <Kpi label={t("Net sales (excl. tax & service)")} value={money(s.netSalesCents, cur)} />
            <Kpi label={t("Orders")} value={String(s.orders)} sub={ch(sum.data?.changePct.orders)} />
            <Kpi label={t("Covers")} value={String(s.covers)} sub={ch(sum.data?.changePct.covers)} />
            <Kpi label={t("Average check")} value={money(s.avgCheckCents, cur)} />
            <Kpi label={t("Average per cover")} value={s.covers ? money(s.avgPerCoverCents, cur) : "—"} sub={t("Orders without covers excluded from the guest count")} />
            <Kpi label={t("Tips (not in sales)")} value={money(s.tipsCents, cur)} />
            <Kpi label={t("Refunds")} value={money(s.refunds.amountCents, cur)} sub={`${s.refunds.count} · ${t("net of refunds")}: ${money(s.netOfRefundsCents, cur)}`} tone={s.refunds.count ? "bad" : undefined} />
            <Kpi label={t("Discounts")} value={money(s.discountCents, cur)} sub={`${t("gross")}: ${money(s.grossCents, cur)}`} />
            <Kpi label={t("Voided sent items")} value={String(s.voids.itemCount)} sub={money(s.voids.itemAmountCents, cur)} />
            <Kpi label={t("Cancelled orders")} value={String(s.voids.orderCount)} />
            <Kpi label={t("Tax")} value={money(s.taxCents, cur)} />
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            <Card><h2 className="font-semibold mb-3">{t("Sales by day")}</h2><Bars data={(byDay.data ?? []).map((d) => ({ label: d.date.slice(5), value: d.totalCents }))} format={(v) => money(v, cur)} /></Card>
            <Card><h2 className="font-semibold mb-3">{t("Sales by hour")}</h2><Bars data={(byHour.data ?? []).map((d) => ({ label: `${d.hour}h`, value: d.totalCents }))} format={(v) => money(v, cur)} /></Card>
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            <div><h2 className="font-semibold mb-2">{t("Top products (gross lines)")}</h2><DataTable rows={(prod.data ?? []).slice(0, 8)} currency={cur} columns={["name", "qty", "grossCents"]} /></div>
            <div><h2 className="font-semibold mb-2">{t("Payment methods")}</h2><DataTable rows={pay.data} currency={cur} columns={["method", "count", "amountCents", "tipsCents", "refundedCents"]} /></div>
          </div>
          <p className="text-xs text-muted">{t("All figures come from closed orders and recorded payments. Revenue is never estimated.")} <Badge>{t("Definitions")}: docs/METRICS.md</Badge></p>
        </>
      )}
    </div>
  );
}
