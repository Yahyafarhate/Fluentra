"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorState, Input, Loading, Select } from "@/components/ui";
import { AdminShell, DataTable } from "@/components/admin";
import { useApi } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

function Inner() {
  const t = useT(); const sp = useSearchParams();
  const [orderId, setOrderId] = useState(sp.get("orderId") ?? ""); const [action, setAction] = useState("");
  const qs = [orderId && /^[0-9a-f-]{36}$/i.test(orderId) ? `orderId=${orderId}` : "", action ? `action=${action}` : ""].filter(Boolean).join("&");
  const { data, loading, error, reload } = useApi<Array<Record<string, unknown>>>(`/audit?limit=200${qs ? `&${qs}` : ""}`);
  return (
    <div className="grid gap-4">
      <div className="flex gap-2 flex-wrap"><Input placeholder={t("Order id")} value={orderId} onChange={(e) => setOrderId(e.target.value)} className="w-96 max-w-full" />
        <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-56"><option value="">{t("All actions")}</option>{["order.", "payment.", "refund.", "cash.", "kds.", "auth.", "product.", "employee.", "integration.", "day."].map((a) => <option key={a} value={a}>{a}…</option>)}</Select></div>
      {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : <DataTable rows={data} columns={["createdAt", "action", "actorLabel", "metadata"]} />}
      <p className="text-xs text-muted">{t("The audit trail is append-only: not even the application can edit or delete it.")}</p>
    </div>
  );
}
export default function Audit() { const t = useT(); return <AdminShell title={t("Audit trail")}>{() => <Suspense><Inner /></Suspense>}</AdminShell>; }
