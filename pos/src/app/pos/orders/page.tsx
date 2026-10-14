"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Empty, ErrorState, Input, Loading, Select } from "@/components/ui";
import { PosShell, useMe } from "@/components/pos-shell";
import { useApi } from "@/lib/client/hooks";
import { hhmm, money, today } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Row { id: string; orderNo: number; businessDate: string; type: string; status: string; totalCents: number | null; tipCents: number; closedAt: string | null; tableLabel: string | null }

export default function OrdersPage() {
  const t = useT(); const router = useRouter(); const me = useMe();
  const [date, setDate] = useState(today()); const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useApi<Row[]>(me?.outletId ? `/orders?outletId=${me.outletId}&date=${date}${status ? `&status=${status}` : ""}` : null);
  return (
    <PosShell me={me} active="orders">
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex gap-2 mb-4 flex-wrap items-end"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" aria-label={t("Date")} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t("Status")}><option value="">{t("All")}</option>{["open", "closed", "void", "merged"].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select></div>
        {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : !data?.length ? <Empty title={t("No order")} /> : (
          <ul className="grid gap-2">{data.map((o) => (
            <li key={o.id}><button onClick={() => router.push(`/pos/order/${o.id}`)} className="w-full flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left hover:border-gold">
              <span className="font-semibold w-14">#{o.orderNo}</span><span className="flex-1">{o.tableLabel ? `${t("Table")} ${o.tableLabel}` : t(o.type)}<span className="text-muted text-sm"> · {hhmm(o.closedAt)}</span></span>
              <Badge tone={o.status === "open" ? "ok" : o.status === "closed" ? "neutral" : "bad"}>{t(o.status)}</Badge>
              <span className="tabular w-28 text-end">{o.totalCents !== null ? money(o.totalCents, me?.org.currency) : "—"}</span></button></li>))}</ul>)}
        <div className="mt-4"><Button variant="ghost" onClick={reload}>{t("Refresh")}</Button></div>
      </div>
    </PosShell>
  );
}
