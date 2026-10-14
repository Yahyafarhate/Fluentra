"use client";
import { useState } from "react";
import { Badge, Button, Card, ErrorState, Input, Loading, Notice } from "@/components/ui";
import { AdminShell, DataTable, Kpi, OutletPicker, useOutlet } from "@/components/admin";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { dateTime, money, today } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Report {
  date: string; sales: { orders: number; covers: number; totalCents: number; netSalesCents: number; taxCents: number; tipsCents: number; discountCents: number; refunds: { count: number; amountCents: number }; voids: { itemCount: number; orderCount: number } };
  paymentMethods: Array<Record<string, unknown>>; reconciliation: { ok: boolean; billedCents: number; paidCents: number; mismatches: unknown[]; pendingPayments: unknown[] };
  openOrders: Array<{ id: string; orderNo: number }>; openCashSessions: Array<{ id: string; drawer: string }>; closed: { closedAt: string } | null;
}

export default function EndOfDay() { const t = useT(); return <AdminShell title={t("End of day")}>{(me) => <Inner cur={me.org.currency} canClose={me.permissions.includes("day.close")} />}</AdminShell>; }
function Inner({ cur, canClose }: { cur: string; canClose: boolean }) {
  const t = useT();
  const { outlets, outlet, setOutletId } = useOutlet(); const [date, setDate] = useState(today());
  const { data, loading, error, reload } = useApi<Report>(outlet ? `/reports/end-of-day?outletId=${outlet.id}&date=${date}` : null);
  const [err, setErr] = useState<string | null>(null);
  const close = async () => { setErr(null); try { await api("POST", "/reports/day-close", { outletId: outlet!.id, date }); await reload(); } catch (e) { setErr((e as ApiError).message); } };
  return (
    <div className="grid gap-4">
      <div className="flex gap-3 items-center flex-wrap"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" /><OutletPicker outlets={outlets} value={outlet?.id ?? ""} onChange={setOutletId} />{data?.closed && <Badge tone="ok">{t("Day closed")} {dateTime(data.closed.closedAt)}</Badge>}<Button variant="secondary" className="ms-auto no-print" onClick={() => window.print()}>{t("Print")}</Button></div>
      {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label={t("Total billed")} value={money(data.sales.totalCents, cur)} /><Kpi label={t("Net sales")} value={money(data.sales.netSalesCents, cur)} /><Kpi label={t("Orders")} value={String(data.sales.orders)} sub={`${data.sales.covers} ${t("covers")}`} /><Kpi label={t("Tips")} value={money(data.sales.tipsCents, cur)} />
            <Kpi label={t("Tax")} value={money(data.sales.taxCents, cur)} /><Kpi label={t("Discounts")} value={money(data.sales.discountCents, cur)} /><Kpi label={t("Refunds")} value={money(data.sales.refunds.amountCents, cur)} sub={`${data.sales.refunds.count}`} /><Kpi label={t("Voids")} value={String(data.sales.voids.itemCount)} sub={`${data.sales.voids.orderCount} ${t("orders")}`} />
          </div>
          <div><h2 className="font-semibold mb-2">{t("Payment methods")}</h2><DataTable rows={data.paymentMethods} currency={cur} columns={["method", "count", "amountCents", "tipsCents", "refundedCents"]} /></div>
          <Notice tone={data.reconciliation.ok ? "ok" : "bad"} title={data.reconciliation.ok ? t("Orders and payments reconcile") : t("Reconciliation differences — see Reports → Reconciliation")}>{money(data.reconciliation.billedCents, cur)} {t("billed")} / {money(data.reconciliation.paidCents, cur)} {t("paid")}</Notice>
          {canClose && !data.closed && (
            <Card><h2 className="font-semibold">{t("Close the business day")}</h2>
              {data.openOrders.length > 0 && <p className="text-sm text-bad mt-2">{t("Open orders")}: {data.openOrders.map((o) => `#${o.orderNo}`).join(", ")}</p>}
              {data.openCashSessions.length > 0 && <p className="text-sm text-bad mt-1">{t("Cash drawers still open")}: {data.openCashSessions.map((c) => c.drawer).join(", ")}</p>}
              {err && <div className="mt-2"><Notice tone="bad">{err}</Notice></div>}
              <p className="text-sm text-ink-2 mt-2">{t("Closing freezes the day: orders of this day can no longer be reopened.")}</p>
              <Button className="mt-3" variant="danger" onClick={close}>{t("Close the day")}</Button></Card>)}
        </>)}
    </div>
  );
}
