"use client";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, Input, Modal, Notice, Select } from "@/components/ui";
import { api, ApiError, newKey } from "@/lib/client/api";
import { money, pct } from "@/lib/client/format";
import type { Floor, ItemView, Me, OrderView } from "@/lib/client/types";
import { useT } from "@/lib/i18n";
import type { Approval } from "@/components/approval";

type WithApproval = <T>(fn: (a?: Approval) => Promise<T>) => Promise<T | undefined>;

export function ReasonDialog({ open, title, confirmLabel, danger, onClose, onConfirm }: { open: boolean; title: string; confirmLabel: string; danger?: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const t = useT();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(""); setErr(null); setBusy(false); } }, [open]);
  const quick = [t("Guest changed mind"), t("Wrong item entered"), t("Kitchen error"), t("Item unavailable")];
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button><Button variant={danger ? "danger" : "primary"} disabled={busy || reason.trim().length < 3} onClick={async () => { setBusy(true); setErr(null); try { await onConfirm(reason.trim()); } catch (e) { setErr((e as ApiError).message); setBusy(false); } }}>{confirmLabel}</Button></>}>
      <div className="flex flex-wrap gap-2 mb-3">{quick.map((q) => <button key={q} onClick={() => setReason(q)} className="px-3 h-9 rounded-full border border-line-strong text-sm hover:bg-sunken">{q}</button>)}</div>
      <Field label={t("Reason (required)")}><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus /></Field>
      {err && <div className="mt-3"><Notice tone="bad">{err}</Notice></div>}
    </Modal>
  );
}

export function DiscountDialog({ open, view, me, onClose, onApply, withApproval }: { open: boolean; view: OrderView; me: Me; onClose: () => void; onApply: () => void; withApproval: WithApproval }) {
  const t = useT();
  const [list, setList] = useState<Array<{ id: string; name: string; kind: string; value: number }>>([]);
  const [sel, setSel] = useState<string>("custom");
  const [kind, setKind] = useState<"percent" | "amount">("percent"); const [value, setValue] = useState("");
  const [item, setItem] = useState(""); const [reason, setReason] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setReason(""); setErr(null); setBusy(false); setValue(""); setItem(""); api<typeof list>("GET", "/discounts").then((d) => { setList(d); setSel(d[0]?.id ?? "custom"); }).catch(() => undefined); } }, [open]);
  const live = view.items.filter((i) => i.status !== "void");
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const num = Math.round(Number(value.replace(",", ".")) * (kind === "percent" ? 100 : 100));
      const done = await withApproval((approval) => api("POST", `/orders/${view.order.id}/discounts`, { ...(sel === "custom" ? { custom: { kind, value: num, name: kind === "percent" ? `${value}%` : t("Custom discount") } } : { discountId: sel }), itemId: item || undefined, reason, approval }));
      if (done !== undefined) { onApply(); onClose(); } else setBusy(false);
    } catch (e) { setErr((e as ApiError).message); setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Discount")} footer={<><Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button><Button disabled={busy || reason.trim().length < 3 || (sel === "custom" && !Number(value.replace(",", ".")))} onClick={run}>{t("Apply")}</Button></>}>
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2">{list.map((d) => <button key={d.id} onClick={() => setSel(d.id)} className={`px-3 h-10 rounded-xl border text-sm ${sel === d.id ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{d.name} · {d.kind === "percent" ? pct(d.value) : money(d.value, me.org.currency)}</button>)}
          <button onClick={() => setSel("custom")} className={`px-3 h-10 rounded-xl border text-sm ${sel === "custom" ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{t("Custom")}</button></div>
        {sel === "custom" && <div className="grid grid-cols-2 gap-3"><Field label={t("Type")}><Select value={kind} onChange={(e) => setKind(e.target.value as "percent" | "amount")}><option value="percent">%</option><option value="amount">{me.org.currency}</option></Select></Field><Field label={t("Value")}><Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field></div>}
        <Field label={t("Apply to")}><Select value={item} onChange={(e) => setItem(e.target.value)}><option value="">{t("Whole order")}</option>{live.map((i: ItemView) => <option key={i.id} value={i.id}>{i.qty}× {i.name}</option>)}</Select></Field>
        <Field label={t("Reason (required)")}><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>
        <p className="text-xs text-muted">{t("Large or custom discounts need a supervisor approval.")}</p>
        {err && <Notice tone="bad">{err}</Notice>}
      </div>
    </Modal>
  );
}

export function TablePickerDialog({ open, title, floor, exclude, multi, onClose, onPick }: { open: boolean; title: string; floor: Floor | null; exclude: string[]; multi?: boolean; onClose: () => void; onPick: (ids: string[]) => Promise<void> }) {
  const t = useT();
  const [sel, setSel] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setSel([]); setErr(null); setBusy(false); } }, [open]);
  const free = floor?.tables.filter((x) => x.status === "available" && !exclude.includes(x.id)) ?? [];
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button><Button disabled={!sel.length || busy} onClick={async () => { setBusy(true); try { await onPick(sel); } catch (e) { setErr((e as ApiError).message); setBusy(false); } }}>{t("Confirm")}</Button></>}>
      {free.length === 0 ? <p className="text-muted">{t("No free table.")}</p> : <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">{free.map((x) => <button key={x.id} onClick={() => setSel(multi ? (sel.includes(x.id) ? sel.filter((s) => s !== x.id) : [...sel, x.id]) : [x.id])} className={`h-16 rounded-xl border text-lg font-semibold ${sel.includes(x.id) ? "bg-charcoal text-white border-charcoal" : "border-line-strong hover:bg-sunken"}`}>{x.label}<span className="block text-xs font-normal opacity-70">{x.seats} {t("seats")}</span></button>)}</div>}
      {err && <div className="mt-3"><Notice tone="bad">{err}</Notice></div>}
    </Modal>
  );
}

export function SplitDialog({ open, view, onClose, onSplit }: { open: boolean; view: OrderView; onClose: () => void; onSplit: (itemIds: string[]) => Promise<void> }) {
  const t = useT();
  const [sel, setSel] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setSel([]); setErr(null); setBusy(false); } }, [open]);
  const items = view.items.filter((i) => i.status !== "void" && i.status !== "draft");
  const seats = [...new Set(items.map((i) => i.seat).filter(Boolean))] as number[];
  const total = items.filter((i) => sel.includes(i.id)).reduce((a, i) => a + i.unitPriceCents * i.qty, 0);
  return (
    <Modal open={open} onClose={onClose} title={t("Split the bill")} footer={<><Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button><Button disabled={!sel.length || sel.length === items.length || busy} onClick={async () => { setBusy(true); try { await onSplit(sel); } catch (e) { setErr((e as ApiError).message); setBusy(false); } }}>{t("Move to a new check")} · {money(total, view.outlet.currency)}</Button></>}>
      <p className="text-sm text-ink-2 mb-2">{t("Select the items that go on the new check. Only items already sent can be split.")}</p>
      {seats.length > 0 && <div className="flex flex-wrap gap-2 mb-3">{seats.sort().map((s) => <button key={s} onClick={() => setSel(items.filter((i) => i.seat === s).map((i) => i.id))} className="px-3 h-9 rounded-full border border-line-strong text-sm hover:bg-sunken">{t("Seat")} {s}</button>)}</div>}
      <ul className="grid gap-2">{items.map((i) => <li key={i.id}><label className={`flex items-center gap-3 rounded-xl border px-3 py-3 ${sel.includes(i.id) ? "border-gold bg-gold-soft" : "border-line"}`}><input type="checkbox" className="size-5" checked={sel.includes(i.id)} onChange={() => setSel(sel.includes(i.id) ? sel.filter((x) => x !== i.id) : [...sel, i.id])} /><span className="flex-1">{i.qty}× {i.name}{i.seat ? <Badge className="ml-2">{t("Seat")} {i.seat}</Badge> : null}</span><span className="tabular">{money(i.unitPriceCents * i.qty, view.outlet.currency)}</span></label></li>)}</ul>
      {err && <div className="mt-3"><Notice tone="bad">{err}</Notice></div>}
    </Modal>
  );
}

export function MergeDialog({ open, view, outletId, onClose, onMerge }: { open: boolean; view: OrderView; outletId: string; onClose: () => void; onMerge: (target: string) => Promise<void> }) {
  const t = useT();
  const [list, setList] = useState<Array<{ id: string; orderNo: number; tableLabel: string | null; type: string }>>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setBusy(false); api<typeof list>("GET", `/outlets/${outletId}/open-orders`).then((l) => setList(l.filter((o) => o.id !== view.order.id))).catch(() => undefined); } }, [open, outletId, view.order.id]);
  return (
    <Modal open={open} onClose={onClose} title={t("Merge into another order")}>
      <p className="text-sm text-ink-2 mb-3">{t("All items move to the order you choose; this order is closed as merged.")}</p>
      {list.length === 0 ? <p className="text-muted">{t("No other open order.")}</p> : <div className="grid gap-2">{list.map((o) => <Button key={o.id} variant="secondary" size="lg" disabled={busy} onClick={async () => { setBusy(true); try { await onMerge(o.id); } catch (e) { setErr((e as ApiError).message); setBusy(false); } }}>#{o.orderNo} · {o.tableLabel ?? t(o.type)}</Button>)}</div>}
      {err && <div className="mt-3"><Notice tone="bad">{err}</Notice></div>}
    </Modal>
  );
}

export function PayDialog({ open, view, me, onClose, onDone }: { open: boolean; view: OrderView; me: Me; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const cur = view.outlet.currency; const due = view.dueCents;
  const [method, setMethod] = useState<"cash" | "card" | "other">("cash");
  const [amount, setAmount] = useState(due); const [tip, setTip] = useState(0); const [tendered, setTendered] = useState<number | null>(null);
  const [guests, setGuests] = useState(1); const [scenario, setScenario] = useState<"approve" | "decline" | "pending">("approve");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<{ closed: boolean; change: number | null; status: string; declined?: string } | null>(null);
  const [key, setKey] = useState(() => newKey("pay"));
  useEffect(() => { if (open) { setMethod("cash"); setAmount(due); setTip(0); setTendered(null); setGuests(1); setErr(null); setResult(null); setBusy(false); setKey(newKey("pay")); } }, [open, due]);

  const share = guests > 1 ? Math.ceil(due / guests) : due;
  const net = Math.min(amount, due);
  const owed = net + tip;
  const change = method === "cash" && tendered !== null ? tendered - owed : 0;
  const cashButtons = useMemo(() => { const set = new Set<number>([owed]); for (const step of [5000, 10000, 20000, 50000]) { const v = Math.ceil(owed / step) * step; if (v >= owed) set.add(v); } return [...set].sort((a, b) => a - b).slice(0, 4); }, [owed]);

  async function pay() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ ok: boolean; closed: boolean; payment: { status: string; changeCents: number | null; declineReason: string | null } }>("POST", `/orders/${view.order.id}/payments`,
        { method, amountCents: net, tipCents: tip, tenderedCents: method === "cash" ? tendered ?? undefined : undefined, idempotencyKey: key, testScenario: method === "card" && me.testPayments ? scenario : undefined });
      setResult({ closed: r.closed, change: r.payment.changeCents, status: r.payment.status, declined: r.payment.declineReason ?? undefined });
      if (r.ok || r.payment.status !== "pending") setKey(newKey("pay")); // definitive outcome → next attempt is a new payment
      if (r.ok) onDone();
    } catch (e) {
      const x = e as ApiError;
      // declined / pending come back as JSON bodies with a payment; real errors:
      setErr({ code: x.code, message: x.message });
    } finally { setBusy(false); }
  }

  const finished = result?.status === "succeeded";
  return (
    <Modal open={open} onClose={() => { if (finished) onDone(); onClose(); }} title={t("Payment")} wide
      footer={finished ? <><a href={`/pos/order/${view.order.id}/receipt`} target="_blank" rel="noreferrer"><Button variant="secondary">{t("Receipt")}</Button></a><Button variant="gold" onClick={() => { onClose(); }}>{result?.closed ? t("Done") : t("Continue")}</Button></> : <><Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button><Button variant="gold" size="lg" disabled={busy || net < 1 || (method === "cash" && tendered !== null && tendered < owed) || (method === "card" && !me.cardPayments)} onClick={pay}>{busy ? t("Processing…") : `${t("Charge")} ${money(owed, cur)}`}</Button></>}>
      {finished ? (
        <div className="text-center py-4">
          <div className="text-5xl">✓</div>
          <h3 className="text-2xl font-semibold mt-2">{result?.closed ? t("Paid in full") : t("Payment recorded")}</h3>
          {result?.change ? <p className="mt-3 text-3xl font-semibold text-gold-strong">{t("Change")}: {money(result.change, cur)}</p> : null}
          {!result?.closed && <p className="mt-2 text-ink-2">{t("Remaining due")}: {money(view.dueCents - net, cur)}</p>}
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="flex items-baseline justify-between rounded-xl bg-canvas px-4 py-3"><span className="text-ink-2">{t("Amount due")}</span><span className="text-3xl font-semibold tabular">{money(due, cur)}</span></div>
          <div className="flex gap-2">{(["cash", "card", ...(["owner", "manager", "supervisor"].includes(me.role) ? ["other"] : [])] as Array<"cash" | "card" | "other">).map((m) => <Button key={m} variant={method === m ? "primary" : "secondary"} className="flex-1" onClick={() => setMethod(m)}>{t(m)}</Button>)}</div>
          {method === "card" && (me.cardPayments ? (me.testPayments && <Notice tone="warn" title={t("TEST card terminal")}>{t("Simulated — no real money moves. Choose the outcome to test:")}<div className="mt-2 flex gap-2">{(["approve", "decline", "pending"] as const).map((s) => <button key={s} onClick={() => setScenario(s)} className={`px-3 h-9 rounded-lg border text-sm ${scenario === s ? "bg-charcoal text-white border-charcoal" : "border-line-strong bg-surface"}`}>{t(s)}</button>)}</div></Notice>) : <Notice tone="bad" title={t("No card terminal configured")}>{t("Card payments cannot be recorded without provider confirmation.")}</Notice>)}
          <div>
            <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-medium text-ink-2">{t("Amount to pay now")}</h3>
              <div className="flex items-center gap-1 text-sm">{t("Split equally between")}<Button size="sm" variant="secondary" onClick={() => { const g = Math.max(1, guests - 1); setGuests(g); setAmount(Math.ceil(due / g)); }}>−</Button><b>{guests}</b><Button size="sm" variant="secondary" onClick={() => { const g = Math.min(20, guests + 1); setGuests(g); setAmount(Math.ceil(due / g)); }}>+</Button></div></div>
            <div className="flex gap-2 items-center"><Input inputMode="decimal" value={(amount / 100).toFixed(2)} onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value.replace(",", ".")) * 100) || 0))} className="text-xl font-semibold" aria-label={t("Amount")} /><Button variant="secondary" onClick={() => { setAmount(due); setGuests(1); }}>{t("Full")}</Button>{guests > 1 && <Badge tone="gold">{money(share, cur)} / {t("guest")}</Badge>}</div>
            {amount > due && <p className="text-xs text-bad mt-1">{t("The amount exceeds what is due; it will be limited to the amount due.")}</p>}
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink-2 mb-2">{t("Tip")}</h3>
            <div className="flex flex-wrap gap-2">{[0, 5, 10, 15].map((p) => <button key={p} onClick={() => setTip(Math.round((net * p) / 100))} className={`h-10 px-4 rounded-xl border text-sm ${tip === Math.round((net * p) / 100) ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{p === 0 ? t("None") : `${p}%`}</button>)}<Input inputMode="decimal" placeholder={t("Custom")} className="w-28" onChange={(e) => setTip(Math.max(0, Math.round(Number(e.target.value.replace(",", ".")) * 100) || 0))} /></div>
          </div>
          {method === "cash" && (
            <div>
              <h3 className="text-sm font-medium text-ink-2 mb-2">{t("Cash received")}</h3>
              <div className="flex flex-wrap gap-2">{cashButtons.map((c) => <button key={c} onClick={() => setTendered(c)} className={`h-12 px-4 rounded-xl border text-lg ${tendered === c ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{c === owed ? t("Exact") : money(c, cur)}</button>)}<Input inputMode="decimal" placeholder={t("Other")} className="w-28" onChange={(e) => setTendered(Math.round(Number(e.target.value.replace(",", ".")) * 100) || null)} /></div>
              {tendered !== null && <p className={`mt-2 text-lg ${change < 0 ? "text-bad" : "text-ok"}`}>{change < 0 ? `${t("Missing")}: ${money(-change, cur)}` : `${t("Change")}: ${money(change, cur)}`}</p>}
            </div>
          )}
          {result?.status === "declined" && <Notice tone="bad" title={t("Card declined")}>{result.declined}</Notice>}
          {result?.status === "pending" && <Notice tone="warn" title={t("Awaiting the terminal")}>{t("The payment is pending. Do not charge again until it is resolved.")}</Notice>}
          {err && <Notice tone="bad" title={err.code === "CASH_SESSION_REQUIRED" ? t("Open a cash drawer first") : undefined}>{err.code === "CASH_SESSION_REQUIRED" ? <a className="underline" href="/pos/cash">{t("Go to the cash drawer")}</a> : err.message}</Notice>}
        </div>
      )}
    </Modal>
  );
}
