"use client";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, Input, Modal, Select } from "@/components/ui";
import { money } from "@/lib/client/format";
import type { MenuProduct } from "@/lib/client/types";
import { useT } from "@/lib/i18n";

export interface ItemDraft { productId: string; qty: number; modifierIds: string[]; note?: string | null; allergyNote?: string | null; seat?: number | null; course?: number; hold?: boolean }

export function ProductDialog({ product, currency, covers, onClose, onAdd }: { product: MenuProduct | null; currency: string; covers: number; onClose: () => void; onAdd: (d: ItemDraft) => void }) {
  const t = useT();
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState(""); const [allergy, setAllergy] = useState("");
  const [seat, setSeat] = useState(""); const [course, setCourse] = useState(1); const [hold, setHold] = useState(false);
  useEffect(() => { if (product) { setSel({}); setQty(1); setNote(""); setAllergy(""); setSeat(""); setCourse(product.defaultCourse); setHold(false); } }, [product]);

  const unit = useMemo(() => (product ? product.priceCents + product.modifierGroups.flatMap((g) => g.modifiers.filter((m) => sel[g.id]?.includes(m.id))).reduce((a, m) => a + m.priceDeltaCents, 0) : 0), [product, sel]);
  const problems = product?.modifierGroups.filter((g) => (sel[g.id]?.length ?? 0) < g.minSelect) ?? [];

  const toggle = (gid: string, mid: string, max: number) => setSel((s) => {
    const cur = s[gid] ?? [];
    if (cur.includes(mid)) return { ...s, [gid]: cur.filter((x) => x !== mid) };
    if (max === 1) return { ...s, [gid]: [mid] };
    return cur.length >= max ? s : { ...s, [gid]: [...cur, mid] };
  });

  return (
    <Modal open={!!product} onClose={onClose} title={product?.name ?? ""} wide
      footer={<><Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="gold" disabled={problems.length > 0} onClick={() => product && onAdd({ productId: product.id, qty, modifierIds: Object.values(sel).flat(), note: note || null, allergyNote: allergy || null, seat: seat ? Number(seat) : null, course, hold })}>{t("Add")} · {money(unit * qty, currency)}</Button></>}>
      {product && (
        <div className="grid gap-4">
          {product.allergens.length > 0 && <div className="flex gap-1 flex-wrap">{product.allergens.map((a) => <Badge key={a} tone="warn">{a}</Badge>)}</div>}
          {product.modifierGroups.map((g) => (
            <div key={g.id}>
              <div className="flex items-baseline justify-between"><h3 className="font-semibold">{g.name}</h3><span className="text-xs text-muted">{g.minSelect > 0 ? t("Required") : t("Optional")} · {g.maxSelect === 1 ? t("choose 1") : t("up to {n}", { n: g.maxSelect })}</span></div>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">{g.modifiers.map((m) => { const on = sel[g.id]?.includes(m.id); return <button key={m.id} onClick={() => toggle(g.id, m.id, g.maxSelect)} className={`min-h-12 rounded-xl border px-3 py-2 text-left text-sm ${on ? "bg-charcoal text-white border-charcoal" : "border-line-strong hover:bg-sunken"}`}>{m.name}{m.priceDeltaCents ? <span className="block text-xs opacity-70">{m.priceDeltaCents > 0 ? "+" : ""}{money(m.priceDeltaCents, currency)}</span> : null}</button>; })}</div>
            </div>
          ))}
          <div className="grid grid-cols-3 gap-3">
            <Field label={t("Quantity")}><div className="flex items-center gap-1"><Button variant="secondary" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="−">−</Button><div className="w-10 text-center text-lg font-semibold">{qty}</div><Button variant="secondary" onClick={() => setQty(Math.min(99, qty + 1))} aria-label="+">+</Button></div></Field>
            <Field label={t("Seat")}><Select value={seat} onChange={(e) => setSeat(e.target.value)}><option value="">—</option>{Array.from({ length: Math.max(covers, 1) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
            <Field label={t("Course")}><Select value={course} onChange={(e) => setCourse(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          </div>
          <Field label={t("Special instructions")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
          <Field label={t("Allergy / dietary note (shown in red in the kitchen)")}><Input value={allergy} onChange={(e) => setAllergy(e.target.value)} maxLength={200} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} className="size-5" />{t("Hold — do not fire until I say so")}</label>
        </div>
      )}
    </Modal>
  );
}
