"use client";
import { useState } from "react";
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, Modal, Notice } from "@/components/ui";
import { PosShell, useMe } from "@/components/pos-shell";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { hhmm, money } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Session {
  id: string; drawer: string; openedAt: string; openedByName: string | null; openingFloatCents: number;
  breakdown: { openingFloatCents: number; cashSalesCents: number; cashTipsCents: number; payInCents: number; payOutCents: number; cashRefundsCents: number; expectedCents: number } | null;
  movements: Array<{ id: string; kind: string; amountCents: number; reason: string; createdAt: string }>;
}
const cents = (s: string) => Math.round(Number(s.replace(",", ".")) * 100) || 0;

export default function CashPage() {
  const t = useT(); const me = useMe(); const cur = me?.org.currency ?? "MAD";
  const { data, error, loading, reload } = useApi<Session[]>(me?.outletId ? `/outlets/${me.outletId}/cash` : null);
  const [float, setFloat] = useState("500"); const [err, setErr] = useState<string | null>(null);
  const [move, setMove] = useState<{ s: Session; kind: "pay_in" | "pay_out" } | null>(null); const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const [closing, setClosing] = useState<Session | null>(null); const [counted, setCounted] = useState(""); const [note, setNote] = useState("");
  const [result, setResult] = useState<{ expected: number; counted: number; variance: number } | null>(null);

  const wrap = async (fn: () => Promise<void>) => { setErr(null); try { await fn(); await reload(); } catch (e) { setErr((e as ApiError).message); } };
  return (
    <PosShell me={me} active="cash">
      <div className="max-w-3xl mx-auto p-4 grid gap-4">
        {err && <Notice tone="bad">{err}</Notice>}
        {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : (
          <>
            {data?.map((s) => (
              <Card key={s.id}>
                <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{t("Drawer")} {s.drawer}</h2><Badge tone="ok">{t("open")} · {hhmm(s.openedAt)} · {s.openedByName}</Badge></div>
                {s.breakdown && <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  {([[t("Opening float"), s.breakdown.openingFloatCents], [t("Cash sales"), s.breakdown.cashSalesCents], [t("Cash tips"), s.breakdown.cashTipsCents], [t("Pay-ins"), s.breakdown.payInCents], [t("Pay-outs"), -s.breakdown.payOutCents], [t("Cash refunds"), -s.breakdown.cashRefundsCents]] as Array<[string, number]>).map(([l, v]) => <div key={l} className="flex justify-between col-span-2 sm:col-span-1"><dt className="text-ink-2">{l}</dt><dd className="tabular">{money(v, cur)}</dd></div>)}
                  <div className="col-span-2 flex justify-between border-t border-line pt-2 text-lg font-semibold"><dt>{t("Expected in drawer")}</dt><dd className="tabular">{money(s.breakdown.expectedCents, cur)}</dd></div></dl>}
                <div className="mt-4 flex gap-2 flex-wrap"><Button variant="secondary" onClick={() => { setMove({ s, kind: "pay_in" }); setAmount(""); setReason(""); }}>{t("Pay-in")}</Button><Button variant="secondary" onClick={() => { setMove({ s, kind: "pay_out" }); setAmount(""); setReason(""); }}>{t("Pay-out")}</Button><Button variant="danger" className="ms-auto" onClick={() => { setClosing(s); setCounted(""); setNote(""); }}>{t("Count & close drawer")}</Button></div>
                {s.movements.length > 0 && <ul className="mt-3 text-sm text-ink-2 grid gap-1">{s.movements.map((m) => <li key={m.id} className="flex justify-between"><span>{hhmm(m.createdAt)} · {t(m.kind)} · {m.reason}</span><span className="tabular">{m.kind === "pay_out" ? "−" : "+"}{money(m.amountCents, cur)}</span></li>)}</ul>}
              </Card>
            ))}
            {data?.length === 0 && (
              <Card><h2 className="text-lg font-semibold">{t("No cash drawer is open")}</h2><p className="text-sm text-ink-2 mb-3">{t("Count the opening float to start taking cash payments.")}</p>
                <div className="flex gap-2 items-end"><Field label={t("Opening float")}><Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
                  <Button size="lg" onClick={() => wrap(async () => { await api("POST", "/cash/sessions", { outletId: me!.outletId, openingFloatCents: cents(float) }); })}>{t("Open drawer")}</Button></div></Card>)}
            {!data && <Empty title={t("No data")} />}
          </>
        )}
      </div>
      <Modal open={!!move} onClose={() => setMove(null)} title={move ? (move.kind === "pay_in" ? t("Pay-in") : t("Pay-out")) : ""} footer={<><Button variant="ghost" onClick={() => setMove(null)}>{t("Cancel")}</Button><Button disabled={!cents(amount) || reason.trim().length < 3} onClick={() => wrap(async () => { await api("POST", `/cash/sessions/${move!.s.id}/movements`, { kind: move!.kind, amountCents: cents(amount), reason }); setMove(null); })}>{t("Record")}</Button></>}>
        <div className="grid gap-3"><Field label={t("Amount")}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field><Field label={t("Reason (required)")}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      </Modal>
      <Modal open={!!closing} onClose={() => { setClosing(null); setResult(null); }} title={t("Close the drawer")}
        footer={result ? <Button onClick={() => { setClosing(null); setResult(null); }}>{t("Done")}</Button> : <><Button variant="ghost" onClick={() => setClosing(null)}>{t("Cancel")}</Button><Button variant="danger" disabled={counted === ""} onClick={() => wrap(async () => { const r = await api<{ expectedCashCents: number; countedCashCents: number; varianceCents: number }>("POST", `/cash/sessions/${closing!.id}/close`, { countedCashCents: cents(counted), note: note || undefined }); setResult({ expected: r.expectedCashCents, counted: r.countedCashCents, variance: r.varianceCents }); })}>{t("Close drawer")}</Button></>}>
        {result ? <div className="text-center py-2"><p className="text-ink-2">{t("Expected")}: {money(result.expected, cur)} · {t("Counted")}: {money(result.counted, cur)}</p><p className={`text-3xl font-semibold mt-2 ${result.variance === 0 ? "text-ok" : "text-bad"}`}>{result.variance === 0 ? t("Balanced") : `${t("Variance")}: ${money(result.variance, cur)}`}</p></div> : (
          <div className="grid gap-3"><Field label={t("Counted cash")} hint={t("Count the drawer without looking at the expected amount.")}><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field><Field label={t("Note (optional)")}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>)}
      </Modal>
    </PosShell>
  );
}
