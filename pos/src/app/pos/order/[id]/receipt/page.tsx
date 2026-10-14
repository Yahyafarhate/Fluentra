"use client";
import { useParams } from "next/navigation";
import { Button, ErrorState, Loading } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { dateTime, money, pct } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Receipt {
  outlet: { name: string; address: string | null; phone: string | null; taxIdentifier: string | null; receiptHeader: string | null; receiptFooter: string | null };
  order: { orderNo: number; type: string; tableLabel: string | null; covers: number; serverName: string | null; openedAt: string; closedAt: string | null; status: string };
  items: Array<{ name: string; qty: number; unitPriceCents: number; discountCents: number; modifiers: string[] }>;
  discounts: Array<{ name: string }>; totals: { grossCents: number; itemDiscountCents: number; orderDiscountCents: number; serviceChargeCents: number; taxCents: number; totalCents: number; taxLines: Array<{ rateBps: number; baseCents: number; taxCents: number }> };
  tipCents: number; payments: Array<{ method: string; amountCents: number; tipCents: number }>; refundedCents: number; currency: string; pricesIncludeTax: boolean; fiscalNotice: string;
}

export default function ReceiptPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { data: r, error, loading, reload } = useApi<Receipt>(`/orders/${id}/receipt`);
  if (loading) return <Loading />;
  if (error || !r) return <ErrorState error={error} retry={reload} />;
  const c = r.currency;
  return (
    <main className="min-h-dvh bg-sunken p-4 print:bg-white print:p-0">
      <div className="no-print max-w-sm mx-auto mb-3 flex gap-2"><Button onClick={() => window.print()}>{t("Print")}</Button><Button variant="secondary" onClick={() => window.close()}>{t("Close")}</Button></div>
      <article className="max-w-sm mx-auto bg-white shadow-card print:shadow-none p-5 font-mono text-[13px] leading-snug">
        <header className="text-center"><div className="text-base font-bold">{r.outlet.name}</div>{r.outlet.address && <div>{r.outlet.address}</div>}{r.outlet.phone && <div>{r.outlet.phone}</div>}{r.outlet.taxIdentifier && <div>ICE/IF: {r.outlet.taxIdentifier}</div>}{r.outlet.receiptHeader && <div className="mt-1">{r.outlet.receiptHeader}</div>}</header>
        <hr className="my-2 border-dashed" />
        <div>#{r.order.orderNo} · {t(r.order.type)}{r.order.tableLabel ? ` · ${t("Table")} ${r.order.tableLabel}` : ""}</div>
        <div>{dateTime(r.order.closedAt ?? r.order.openedAt)} · {r.order.serverName}{r.order.covers ? ` · ${r.order.covers} ${t("guests")}` : ""}</div>
        <hr className="my-2 border-dashed" />
        {r.items.map((i, n) => <div key={n}><div className="flex justify-between gap-2"><span>{i.qty}× {i.name}</span><span>{money(i.unitPriceCents * i.qty, c)}</span></div>{i.modifiers.length > 0 && <div className="ps-4 text-[12px]">+ {i.modifiers.join(", ")}</div>}{i.discountCents > 0 && <div className="ps-4 flex justify-between"><span>{t("Discount")}</span><span>−{money(i.discountCents, c)}</span></div>}</div>)}
        <hr className="my-2 border-dashed" />
        {r.totals.orderDiscountCents > 0 && <div className="flex justify-between"><span>{t("Discounts")}</span><span>−{money(r.totals.orderDiscountCents, c)}</span></div>}
        {r.totals.serviceChargeCents > 0 && <div className="flex justify-between"><span>{t("Service charge")}</span><span>{money(r.totals.serviceChargeCents, c)}</span></div>}
        <div className="flex justify-between text-base font-bold"><span>{t("TOTAL")}</span><span>{money(r.totals.totalCents, c)}</span></div>
        <div className="mt-1 text-[12px]">{r.pricesIncludeTax ? t("Prices include tax") : t("Tax added")}:{r.totals.taxLines.map((l) => <div key={l.rateBps} className="flex justify-between"><span>{pct(l.rateBps)} · {t("base")} {money(l.baseCents, c)}</span><span>{money(l.taxCents, c)}</span></div>)}</div>
        <hr className="my-2 border-dashed" />
        {r.payments.map((p, n) => <div key={n} className="flex justify-between"><span>{t(p.method)}</span><span>{money(p.amountCents, c)}</span></div>)}
        {r.tipCents > 0 && <div className="flex justify-between"><span>{t("Tip")}</span><span>{money(r.tipCents, c)}</span></div>}
        {r.refundedCents > 0 && <div className="flex justify-between"><span>{t("Refunded")}</span><span>−{money(r.refundedCents, c)}</span></div>}
        {r.outlet.receiptFooter && <div className="text-center mt-3">{r.outlet.receiptFooter}</div>}
        <p className="mt-4 text-[10px] text-center text-muted print:text-black">{r.fiscalNotice}</p>
      </article>
    </main>
  );
}
