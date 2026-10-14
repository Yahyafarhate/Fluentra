"use client";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Empty, ErrorState, Input, Loading, Modal, Notice } from "@/components/ui";
import { PosShell, useMe } from "@/components/pos-shell";
import { useApproval } from "@/components/approval";
import { ProductDialog, type ItemDraft } from "@/components/order/product-dialog";
import { DiscountDialog, MergeDialog, PayDialog, ReasonDialog, SplitDialog, TablePickerDialog } from "@/components/order/dialogs";
import { api, newKey, ApiError } from "@/lib/client/api";
import { useApi, useLive } from "@/lib/client/hooks";
import { hhmm, money } from "@/lib/client/format";
import type { Floor, ItemView, Menu, MenuProduct, OrderView } from "@/lib/client/types";
import { useT } from "@/lib/i18n";

const STATUS_TONE: Record<string, "neutral" | "info" | "gold" | "ok" | "warn" | "bad" | "violet"> = { draft: "neutral", held: "violet", fired: "info", accepted: "info", preparing: "gold", ready: "ok", served: "neutral", void: "bad" };

export default function OrderPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const { data: view, error, loading, reload, setData } = useApi<OrderView>(`/orders/${id}`);
  const outletId = view?.order.outletId ?? me?.outletId ?? null;
  const { data: menu } = useApi<Menu>(outletId ? `/outlets/${outletId}/menu` : null);
  useLive(outletId, reload, 6000);
  const { withApproval, dialog: approvalDialog } = useApproval();

  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [dlg, setDlg] = useState<null | "product" | "discount" | "transfer" | "combine" | "split" | "merge" | "pay" | "voidOrder" | "reopen" | "more" | "refund">(null);
  const [product, setProduct] = useState<MenuProduct | null>(null);
  const [voidItem, setVoidItem] = useState<ItemView | null>(null);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [msg, setMsg] = useState<{ tone: "bad" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refundFor, setRefundFor] = useState<{ id: string; amountCents: number } | null>(null);

  const open = view?.order.status === "open";
  const currency = view?.outlet.currency ?? "MAD";
  const perm = (p: string) => !!me?.permissions.includes(p);

  const run = useCallback(async (fn: () => Promise<OrderView | undefined | void>) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (r && typeof r === "object" && "order" in r) setData(r as OrderView); else await reload(); }
    catch (e) { setMsg({ tone: "bad", text: (e as ApiError).message }); await reload(); }
    finally { setBusy(false); }
  }, [reload, setData]);

  const add = (d: ItemDraft) => run(async () => { const r = await api<OrderView>("POST", `/orders/${id}/items`, { items: [d] }, { idempotencyKey: newKey("add") }); setDlg(null); setProduct(null); return r; });
  const tap = (p: MenuProduct) => {
    if (!open || !p.available) return;
    if (p.modifierGroups.length) { setProduct(p); setDlg("product"); } else add({ productId: p.id, qty: 1, modifierIds: [], course: p.defaultCourse });
  };

  const items = view?.items ?? [];
  const drafts = items.filter((i) => i.status === "draft");
  const held = items.filter((i) => i.status === "held");
  const ready = items.filter((i) => i.status === "ready");
  const heldCourses = [...new Set(held.map((i) => i.course))].sort();
  const live = items.filter((i) => i.status !== "void");
  const byCourse = useMemo(() => { const m = new Map<number, ItemView[]>(); for (const i of live) m.set(i.course, [...(m.get(i.course) ?? []), i]); return [...m.entries()].sort((a, b) => a[0] - b[0]); }, [live]);

  const products = useMemo(() => (menu?.products ?? []).filter((p) => (cat === "all" || p.categoryId === cat) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))), [menu, cat, q]);

  async function loadFloor() { if (!outletId) return; setFloor(await api<Floor>("GET", `/outlets/${outletId}/floor`)); }
  const unavailable = async (p: MenuProduct) => { if (!outletId) return; await run(async () => { await api("PATCH", `/outlets/${outletId}/products/${p.id}/availability`, { available: !p.available }); window.location.reload(); }); };

  if (loading || !me) return <PosShell me={me}><Loading /></PosShell>;
  if (error || !view) return <PosShell me={me}><ErrorState error={error} retry={reload} /></PosShell>;
  const o = view.order;

  return (
    <PosShell me={me} active="floor">
      <div className="grid lg:grid-cols-[1fr_400px] h-[calc(100dvh-3.5rem)]">
        {/* ───── menu ───── */}
        <section className="flex flex-col min-h-0 border-e border-line">
          <div className="p-3 flex gap-2 items-center border-b border-line bg-surface">
            <Button variant="ghost" size="sm" onClick={() => router.push("/pos")}>← {t("Floor")}</Button>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search the menu")} className="max-w-xs h-10" aria-label={t("Search the menu")} />
            <div className="flex gap-1 overflow-x-auto scroll-thin">
              {[{ id: "all", name: t("All") }, ...(menu?.categories ?? [])].map((c) => <button key={c.id} onClick={() => setCat(c.id)} className={`h-10 px-4 rounded-xl text-sm whitespace-nowrap ${cat === c.id ? "bg-charcoal text-white" : "hover:bg-sunken text-ink-2"}`}>{c.name}</button>)}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 scroll-thin">
            {!open ? <Notice tone="info" title={t("This order is {status}", { status: t(o.status) })}>{t("Items can no longer be added.")}</Notice> : products.length === 0 ? <Empty title={t("No item")} hint={t("Add products in the back office (Menu).")} /> : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {products.map((p) => (
                  <div key={p.id} className="relative">
                    <button onClick={() => tap(p)} disabled={busy || !p.available} className={`w-full min-h-24 rounded-2xl border p-3 pe-14 text-left transition active:scale-[.98] ${p.available ? "bg-surface border-line hover:border-gold" : "bg-sunken border-line opacity-60"}`}>
                      <div className="font-medium leading-tight">{p.name}</div>
                      <div className="mt-1 text-sm text-ink-2 tabular">{money(p.priceCents, currency)}</div>
                      <div className="mt-2 flex gap-1 flex-wrap">{!p.available && <Badge tone="bad">{t("Out of stock")}</Badge>}{p.modifierGroups.length > 0 && <Badge>{t("options")}</Badge>}{p.allergens.slice(0, 2).map((a) => <Badge key={a} tone="warn">{a}</Badge>)}</div>
                    </button>
                    <div className="absolute top-1 end-1 flex gap-0.5">
                      {p.available && <button aria-label={t("Customize")} onClick={() => { setProduct(p); setDlg("product"); }} className="size-8 rounded-lg hover:bg-sunken text-ink-2">⋯</button>}
                      <button aria-label={p.available ? t("Mark out of stock") : t("Back in stock")} title={p.available ? t("Mark out of stock") : t("Back in stock")} onClick={() => unavailable(p)} className="size-8 rounded-lg hover:bg-sunken text-ink-2 text-xs">{p.available ? "86" : "↺"}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ───── ticket ───── */}
        <aside className="flex flex-col min-h-0 bg-surface">
          <div className="p-3 border-b border-line">
            <div className="flex items-center justify-between">
              <div><h1 className="text-xl font-semibold">{o.tableLabel ? `${t("Table")} ${o.tableLabel}${o.tables.length ? " + " + o.tables.map((x) => x.label).join(", ") : ""}` : t(o.type)} <span className="text-muted font-normal">#{o.orderNo}</span></h1>
                <p className="text-sm text-ink-2">{o.covers > 0 ? `${o.covers} ${t("guests")} · ` : ""}{o.serverName} · {hhmm(o.openedAt)}{o.roomRef ? ` · ${o.roomRef}` : ""}</p></div>
              <Badge tone={o.status === "open" ? "ok" : o.status === "closed" ? "neutral" : "bad"}>{t(o.status)}</Badge>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 scroll-thin">
            {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
            {live.length === 0 ? <Empty title={t("Empty order")} hint={t("Tap items on the left to add them.")} /> : byCourse.map(([course, list]) => (
              <div key={course} className="mb-4">
                {byCourse.length > 1 && <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{t("Course")} {course}</div>}
                <ul className="grid gap-2">
                  {list.map((i) => (
                    <li key={i.id} className="rounded-xl border border-line p-2.5">
                      <div className="flex gap-2">
                        <div className="font-semibold w-6 tabular">{i.qty}×</div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium leading-tight">{i.name}{i.seat ? <span className="text-muted font-normal"> · {t("Seat")} {i.seat}</span> : null}</div>
                          {i.modifiers.length > 0 && <div className="text-sm text-ink-2">{i.modifiers.map((m) => m.name).join(", ")}</div>}
                          {i.note && <div className="text-sm text-info">“{i.note}”</div>}
                          {i.allergyNote && <div className="text-sm font-semibold text-bad">⚠ {i.allergyNote}</div>}
                          {i.discountCents > 0 && <div className="text-xs text-ok">−{money(i.discountCents, currency)}</div>}
                        </div>
                        <div className="text-end"><div className="tabular font-medium">{money(i.unitPriceCents * i.qty, currency)}</div><Badge tone={STATUS_TONE[i.status]} className="mt-1">{t(i.status)}</Badge></div>
                      </div>
                      {open && (
                        <div className="mt-2 flex gap-2 justify-end">
                          {["draft", "held"].includes(i.status) && i.qty > 1 && <Button size="sm" variant="ghost" onClick={() => run(() => api<OrderView>("PATCH", `/orders/${id}/items/${i.id}`, { qty: i.qty - 1 }))}>−</Button>}
                          {["draft", "held"].includes(i.status) && <Button size="sm" variant="ghost" onClick={() => run(() => api<OrderView>("PATCH", `/orders/${id}/items/${i.id}`, { qty: Math.min(99, i.qty + 1) }))}>+</Button>}
                          <Button size="sm" variant="ghost" className="text-bad" onClick={() => { if (["draft", "held"].includes(i.status)) run(() => api<OrderView>("POST", `/orders/${id}/items/${i.id}/void`, { reason: t("Removed before sending") })); else setVoidItem(i); }}>{["draft", "held"].includes(i.status) ? t("Remove") : t("Void")}</Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="border-t border-line p-3 bg-canvas">
            <dl className="text-sm grid gap-1">
              <Row l={t("Subtotal")} v={money(view.totals.grossCents, currency)} />
              {view.totals.itemDiscountCents + view.totals.orderDiscountCents > 0 && <Row l={t("Discounts")} v={`−${money(view.totals.itemDiscountCents + view.totals.orderDiscountCents, currency)}`} tone="ok" />}
              {view.totals.serviceChargeCents > 0 && <Row l={t("Service charge")} v={money(view.totals.serviceChargeCents, currency)} />}
              <Row l={view.outlet.pricesIncludeTax ? t("incl. tax") : t("Tax")} v={money(view.totals.taxCents, currency)} muted />
              <div className="flex justify-between items-baseline pt-1 border-t border-line"><dt className="font-semibold text-lg">{t("Total")}</dt><dd className="text-2xl font-semibold tabular">{money(view.totals.totalCents, currency)}</dd></div>
              {view.paidCents > 0 && <Row l={t("Paid")} v={money(view.paidCents, currency)} tone="ok" />}
              {open && view.paidCents > 0 && <Row l={t("Remaining due")} v={money(view.dueCents, currency)} bold />}
            </dl>
            {view.discounts.length > 0 && open && <div className="flex gap-1 flex-wrap mt-2">{view.discounts.map((d) => <button key={d.id} onClick={() => run(() => api<OrderView>("DELETE", `/orders/${id}/discounts/${d.id}`))} className="text-xs rounded-full bg-ok-soft text-ok px-2 py-1">{d.name} ×</button>)}</div>}
            {open ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button size="lg" disabled={busy || drafts.length === 0} onClick={() => run(() => api<OrderView>("POST", `/orders/${id}/send`, undefined, { idempotencyKey: newKey("send") }))}>{t("Send")}{drafts.length ? ` (${drafts.length})` : ""}</Button>
                <Button size="lg" variant="gold" disabled={busy || live.length === 0 || drafts.length > 0} onClick={() => setDlg("pay")} title={drafts.length ? t("Send the new items first") : undefined}>{t("Pay")}</Button>
                {heldCourses.map((c) => <Button key={c} variant="secondary" disabled={busy} onClick={() => run(() => api<OrderView>("POST", `/orders/${id}/fire`, { course: c }, { idempotencyKey: newKey("fire") }))}>{t("Fire course {n}", { n: c })}</Button>)}
                {ready.length > 0 && <Button variant="secondary" disabled={busy} onClick={() => run(() => api<OrderView>("POST", `/orders/${id}/serve`, {}))}>{t("Served")} ({ready.length})</Button>}
                <Button variant="secondary" disabled={busy || live.length === 0} onClick={() => run(() => api<OrderView>("POST", `/orders/${id}/bill-request`))}>{t("Request the bill")}</Button>
                <Button variant="secondary" onClick={() => setDlg("more")}>{t("More…")}</Button>
              </div>
            ) : o.status === "closed" ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <a href={`/pos/order/${id}/receipt`} target="_blank" rel="noreferrer"><Button variant="secondary" className="w-full">{t("Receipt")}</Button></a>
                <Button variant="secondary" onClick={() => setDlg("reopen")}>{t("Reopen")}</Button>
                {perm("refunds.create") && view.payments.filter((p) => p.status === "succeeded").map((p) => <Button key={p.id} variant="secondary" className="col-span-2" onClick={() => { setRefundFor({ id: p.id, amountCents: p.amountCents }); setDlg("refund"); }}>{t("Refund")} · {t(p.method)} {money(p.amountCents, currency)}</Button>)}
              </div>
            ) : null}
            {view.refundedCents > 0 && <p className="text-sm text-bad mt-2">{t("Refunded")}: {money(view.refundedCents, currency)}</p>}
          </div>
        </aside>
      </div>

      <ProductDialog product={dlg === "product" ? product : null} currency={currency} covers={o.covers} onClose={() => { setDlg(null); setProduct(null); }} onAdd={add} />
      <Modal open={dlg === "more"} onClose={() => setDlg(null)} title={t("More actions")}>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={() => setDlg("discount")}>{t("Discount")}</Button>
          <Button variant="secondary" size="lg" disabled={!o.tableId} onClick={async () => { await loadFloor(); setDlg("transfer"); }}>{t("Move to another table")}</Button>
          <Button variant="secondary" size="lg" disabled={!o.tableId} onClick={async () => { await loadFloor(); setDlg("combine"); }}>{t("Combine tables")}</Button>
          <Button variant="secondary" size="lg" disabled={items.filter((i) => !["draft", "void"].includes(i.status)).length < 2} onClick={() => setDlg("split")}>{t("Split the bill")}</Button>
          <Button variant="secondary" size="lg" onClick={() => setDlg("merge")}>{t("Merge orders")}</Button>
          {o.tables.map((x) => <Button key={x.id} variant="secondary" onClick={() => { setDlg(null); run(() => api<OrderView>("POST", `/orders/${id}/release-table`, { tableId: x.id })); }}>{t("Release table")} {x.label}</Button>)}
          <Button variant="danger" size="lg" className="col-span-2" onClick={() => setDlg("voidOrder")}>{t("Void the whole order")}</Button>
        </div>
      </Modal>
      <DiscountDialog open={dlg === "discount"} view={view} me={me} onClose={() => setDlg(null)} onApply={reload} withApproval={withApproval} />
      <TablePickerDialog open={dlg === "transfer"} title={t("Move to another table")} floor={floor} exclude={[]} onClose={() => setDlg(null)} onPick={async ([tid]) => { const r = await api<OrderView>("POST", `/orders/${id}/transfer`, { tableId: tid }, { idempotencyKey: newKey("tr") }); setData(r); setDlg(null); }} />
      <TablePickerDialog open={dlg === "combine"} title={t("Combine tables")} floor={floor} exclude={o.tableId ? [o.tableId] : []} multi onClose={() => setDlg(null)} onPick={async (ids) => { const r = await api<OrderView>("POST", `/orders/${id}/combine`, { tableIds: ids }); setData(r); setDlg(null); }} />
      <SplitDialog open={dlg === "split"} view={view} onClose={() => setDlg(null)} onSplit={async (itemIds) => { const r = await api<{ to: OrderView }>("POST", `/orders/${id}/move-items`, { itemIds }, { idempotencyKey: newKey("split") }); setDlg(null); router.push(`/pos/order/${r.to.order.id}`); }} />
      <MergeDialog open={dlg === "merge"} view={view} outletId={o.outletId} onClose={() => setDlg(null)} onMerge={async (target) => { await api("POST", `/orders/${id}/merge`, { intoOrderId: target }, { idempotencyKey: newKey("merge") }); router.push(`/pos/order/${target}`); }} />
      <PayDialog open={dlg === "pay"} view={view} me={me} onClose={() => { setDlg(null); reload(); }} onDone={reload} />
      <ReasonDialog open={!!voidItem} title={t("Void {name}", { name: voidItem?.name ?? "" })} confirmLabel={t("Void")} danger onClose={() => setVoidItem(null)}
        onConfirm={async (reason) => { const r = await withApproval((approval) => api<OrderView>("POST", `/orders/${id}/items/${voidItem!.id}/void`, { reason, approval })); if (r) setData(r); setVoidItem(null); }} />
      <ReasonDialog open={dlg === "voidOrder"} title={t("Void the whole order")} confirmLabel={t("Void order")} danger onClose={() => setDlg(null)}
        onConfirm={async (reason) => { const r = await withApproval((approval) => api<OrderView>("POST", `/orders/${id}/void`, { reason, approval })); if (r) { router.push("/pos"); } }} />
      <ReasonDialog open={dlg === "reopen"} title={t("Reopen the order")} confirmLabel={t("Reopen")} onClose={() => setDlg(null)}
        onConfirm={async (reason) => { const r = await withApproval((approval) => api<OrderView>("POST", `/orders/${id}/reopen`, { reason, approval })); if (r) { setData(r); setDlg(null); } }} />
      <ReasonDialog open={dlg === "refund"} title={t("Refund")} confirmLabel={t("Refund")} danger onClose={() => setDlg(null)}
        onConfirm={async (reason) => { const key = newKey("refund"); const r = await withApproval((approval) => api("POST", `/payments/${refundFor!.id}/refunds`, { amountCents: refundFor!.amountCents, reason, approval, idempotencyKey: key })); if (r) { setDlg(null); reload(); } }} />
      {approvalDialog}
    </PosShell>
  );
}

function Row({ l, v, tone, muted, bold }: { l: string; v: string; tone?: "ok"; muted?: boolean; bold?: boolean }) {
  return <div className={`flex justify-between ${muted ? "text-muted" : ""} ${tone === "ok" ? "text-ok" : ""} ${bold ? "font-semibold" : ""}`}><dt>{l}</dt><dd className="tabular">{v}</dd></div>;
}
