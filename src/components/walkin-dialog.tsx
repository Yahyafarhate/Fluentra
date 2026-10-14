"use client";
import { useEffect, useState } from "react";
import { Button, Dialog, Field, Input, Notice, Select } from "./ui";
import { useApp } from "./app-shell";
import { useFeedback } from "./feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";

/** Seat a party without a reservation, immediately, at a free table. */
export function WalkInDialog({ open, onClose, onDone, presetTableId, presetParty, waitlistEntryId, presetName }: {
  open: boolean; onClose: () => void; onDone: () => void; presetTableId?: string; presetParty?: number; waitlistEntryId?: string; presetName?: string;
}) {
  const { t } = useI18n();
  const { locationId } = useApp();
  const { toast } = useFeedback();
  const [party, setParty] = useState(2); const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [tableId, setTableId] = useState("auto");
  const [free, setFree] = useState<Array<{ id: string; name: string; capacity: number }>>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open || !locationId) return;
    setErr(null); setParty(presetParty ?? 2); setName(presetName ?? ""); setPhone(""); setTableId(presetTableId ?? "auto");
    api.get(`/api/v1/floor/state?locationId=${locationId}`).then((st) => setFree(st.tables.filter((x: { displayStatus: string }) => x.displayStatus === "available"))).catch(() => setFree([]));
  }, [open, locationId, presetTableId, presetParty, presetName]);

  const fits = free.filter((x) => x.capacity >= party);
  async function go() {
    if (!locationId) return;
    setBusy(true); setErr(null);
    try {
      await api.post("/api/v1/walk-ins", { locationId, partySize: party, guestName: name || undefined, guestPhone: phone || undefined, tableIds: tableId !== "auto" ? [tableId] : undefined, waitlistEntryId });
      toast.success(t("Party seated")); onDone(); onClose();
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={t("Seat a walk-in")} description={t("Creates a visit and marks the table occupied.")}
      footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} onClick={go}>{t("Seat now")}</Button></>}>
      <div className="space-y-4 pt-2">
        <Field label={t("Guests")}><div className="flex items-center gap-2"><Button aria-label="−" onClick={() => setParty(Math.max(1, party - 1))}>−</Button><Input type="number" min={1} className="text-center" value={party} onChange={(e) => setParty(Math.max(1, Number(e.target.value) || 1))} /><Button aria-label="+" onClick={() => setParty(party + 1)}>+</Button></div></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Name (optional)")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Phone (optional)")}><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <Field label={t("Table")} hint={fits.length ? undefined : t("No free table fits this party right now.")}>
          <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="auto">{t("Auto-assign best free table")}</option>
            {fits.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.capacity} {t("seats")}</option>)}
          </Select>
        </Field>
        {err && <Notice tone="bad">{err.message}</Notice>}
      </div>
    </Dialog>
  );
}
