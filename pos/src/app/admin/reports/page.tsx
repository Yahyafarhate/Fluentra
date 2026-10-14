"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, ErrorState, Loading, Notice, Tabs } from "@/components/ui";
import { AdminShell, DataTable, OutletPicker, RangePicker, useOutlet, useRange } from "@/components/admin";
import { useApi } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

type Tab = "products" | "categories" | "employees" | "hours" | "days" | "payments" | "exceptions" | "tables" | "reconcile" | "orders";
const PATHS: Record<Tab, string> = { products: "by-product", categories: "by-category", employees: "by-employee", hours: "by-hour", days: "by-day", payments: "payment-methods", exceptions: "discounts-voids", tables: "tables", reconcile: "reconcile", orders: "orders" };

export default function Reports() { const t = useT(); return <AdminShell title={t("Reports")}>{(me) => <Inner cur={me.org.currency} canExport={me.permissions.includes("reports.export")} />}</AdminShell>; }

function Inner({ cur, canExport }: { cur: string; canExport: boolean }) {
  const t = useT(); const router = useRouter();
  const { outlets, outlet, setOutletId } = useOutlet(); const [r, setR] = useRange(7); const [tab, setTab] = useState<Tab>("products");
  const q = `from=${r.from}&to=${r.to}${outlet ? `&outletId=${outlet.id}` : ""}`;
  const { data, loading, error, reload } = useApi<unknown>(outlet ? `/reports/${PATHS[tab]}?${q}` : null, [tab]);
  const exportKind = ({ products: "products", employees: "employees", payments: "payments", orders: "orders" } as Record<string, string>)[tab];
  const d = data as Record<string, unknown>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3 justify-between"><RangePicker from={r.from} to={r.to} onChange={setR} /><OutletPicker outlets={outlets} value={outlet?.id ?? ""} onChange={setOutletId} /></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "products", label: t("Products") }, { id: "categories", label: t("Categories") }, { id: "employees", label: t("Employees") }, { id: "hours", label: t("Hours") }, { id: "days", label: t("Days") }, { id: "payments", label: t("Payments") }, { id: "exceptions", label: t("Discounts, voids, refunds") }, { id: "tables", label: t("Tables") }, { id: "orders", label: t("Orders") }, { id: "reconcile", label: t("Reconciliation") }]} />
      {canExport && exportKind && <div><a href={`/api/v1/reports/export?${q}&kind=${exportKind}`}><Button variant="secondary" size="sm">⬇ CSV</Button></a></div>}
      {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : tab === "exceptions" ? (
        <div className="grid gap-5">{(["discounts", "voidedItems", "refunds", "cancelledOrders"] as const).map((k) => <div key={k}><h2 className="font-semibold mb-2">{t(k === "voidedItems" ? "Voided sent items" : k === "cancelledOrders" ? "Cancelled orders" : k === "refunds" ? "Refunds" : "Discounts used")}</h2><DataTable rows={d?.[k] as never} currency={cur} columns={k === "discounts" ? ["name", "kind", "count"] : k === "voidedItems" ? ["orderNo", "name", "qty", "amountCents", "reason", "by", "approvedBy", "at"] : k === "refunds" ? ["orderNo", "method", "amountCents", "reason", "by", "approvedBy", "createdAt"] : ["orderNo", "reason", "closedAt"]} onRow={k === "discounts" ? undefined : (row) => router.push(`/admin/audit?orderId=${row.orderId}`)} empty={t("None")} /></div>)}</div>
      ) : tab === "reconcile" ? <Reconcile d={d} cur={cur} /> : tab === "orders" ? <DataTable rows={data as never} currency={cur} columns={["orderNo", "businessDate", "type", "covers", "totalCents", "tipCents", "serverName", "closedAt"]} onRow={(row) => router.push(`/admin/audit?orderId=${row.id}`)} /> : <DataTable rows={data as never} currency={cur} />}
      <p className="text-xs text-muted">{t("Product and category figures are gross item lines (before order-level discounts, service charge and tax). Totals by day/hour/employee use the billed total of closed orders.")}</p>
    </div>
  );
}

function Reconcile({ d, cur }: { d: Record<string, unknown>; cur: string }) {
  const t = useT();
  const ok = d.ok as boolean;
  return (
    <div className="grid gap-4">
      <Notice tone={ok ? "ok" : "bad"} title={ok ? t("Everything reconciles") : t("Differences found")}>{t("Billed total of closed orders")}: <b>{(Number(d.billedCents) / 100).toFixed(2)}</b> {cur} · {t("Payments recorded")}: <b>{(Number(d.paidCents) / 100).toFixed(2)}</b> {cur} · {Number(d.orders)} {t("orders")}</Notice>
      <div className="grid sm:grid-cols-3 gap-3 text-sm"><Badge tone={Number(d.declinedPayments) ? "warn" : "ok"}>{t("Declined payments")}: {Number(d.declinedPayments)}</Badge><Badge tone={Number(d.failedRefunds) ? "bad" : "ok"}>{t("Failed refunds")}: {Number(d.failedRefunds)}</Badge></div>
      <div><h2 className="font-semibold mb-2">{t("Orders whose payments do not match")}</h2><DataTable rows={d.mismatches as never} currency={cur} columns={["orderNo", "billedCents", "paidCents"]} empty={t("None")} /></div>
      <div><h2 className="font-semibold mb-2">{t("Pending payments older than 5 minutes (check the terminal)")}</h2><DataTable rows={d.pendingPayments as never} currency={cur} columns={["orderNo", "method", "amountCents", "createdAt"]} empty={t("None")} /></div>
      <div><h2 className="font-semibold mb-2">{t("Cash drawer variances")}</h2><DataTable rows={d.cashVariances as never} currency={cur} columns={["drawer", "expectedCashCents", "countedCashCents", "varianceCents", "closedAt"]} empty={t("None")} /></div>
    </div>
  );
}
