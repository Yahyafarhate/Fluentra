"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Skeleton, Switch, Textarea } from "@/components/ui";
import { useApp } from "@/components/app-shell";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { useLocationSettings } from "./use-location";

export function BookingTab() {
  const { t } = useI18n();
  const { hasFeature } = useApp();
  const { confirm } = useFeedback();
  const s = useLocationSettings();
  const [f, setF] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => { if (s.loc) setF({ ...s.loc, maxCoversPerSlot: s.loc.maxCoversPerSlot ?? "", durationRules: s.loc.durationRules, waitlistPriority: s.loc.waitlistPriority, policyText: s.loc.policyText ?? "" }); }, [s.loc]);
  if (!f) return <Skeleton className="h-96" />;
  const fe = s.error?.fields ?? {};
  const num = (k: string) => ({ type: "number" as const, value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value === "" ? "" : Number(e.target.value) }) });
  const deposits = hasFeature("deposits");

  async function save(keys: string[], sensitive?: string) {
    if (sensitive && !(await confirm({ title: t("Confirm this change"), message: sensitive, confirmLabel: t("Apply change") }))) return;
    const body: Record<string, unknown> = {}; for (const k of keys) body[k] = k === "maxCoversPerSlot" && f[k] === "" ? null : f[k];
    await s.patch(body);
  }
  const rules: Array<{ maxParty: number; minutes: number }> = f.durationRules;
  const setRule = (i: number, k: "maxParty" | "minutes", v: number) => setF({ ...f, durationRules: rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)) });
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title={t("Online booking")} />
        <div className="space-y-4">
          <Switch checked={f.onlineBookingEnabled} onChange={(v) => setF({ ...f, onlineBookingEnabled: v })} label={t("Accept online bookings")} description={t("Turning this off hides availability on your public page. Staff can still book.")} />
          <Switch checked={f.autoConfirm} onChange={(v) => setF({ ...f, autoConfirm: v })} label={t("Confirm online bookings automatically")} description={t("Off = they arrive as “pending” for staff to confirm.")} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Min. party (online)")} error={fe.minParty}><Input min={1} {...num("minParty")} /></Field>
            <Field label={t("Max party (online)")} error={fe.maxPartyOnline}><Input min={1} {...num("maxPartyOnline")} /></Field>
            <Field label={t("Max party (staff)")} error={fe.maxParty} hint={t("Larger groups: phone the restaurant.")}><Input min={1} {...num("maxParty")} /></Field>
            <Field label={t("Booking window (days)")} error={fe.bookingWindowDays}><Input min={1} max={730} {...num("bookingWindowDays")} /></Field>
            <Field label={t("Minimum notice (minutes)")} error={fe.minNoticeMin} hint={t("Online only")}><Input min={0} {...num("minNoticeMin")} /></Field>
            <Field label={t("Cover limit per slot")} error={fe.maxCoversPerSlot} hint={t("Empty = unlimited (pacing)")}><Input min={1} {...num("maxCoversPerSlot")} /></Field>
          </div>
          <Button variant="primary" loading={s.saving} onClick={() => save(["onlineBookingEnabled", "autoConfirm", "minParty", "maxPartyOnline", "maxParty", "bookingWindowDays", "minNoticeMin", "maxCoversPerSlot"], !f.onlineBookingEnabled && s.loc.onlineBookingEnabled ? t("Online booking will stop immediately: guests will no longer see available times.") : undefined)}>{t("Save online booking")}</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("Seating duration & timing")} subtitle={t("How long a table is held, by party size.")} />
        <div className="space-y-2 mb-4">
          {rules.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-sm"><span className="w-24 text-muted">{t("Parties up to")}</span><Input type="number" min={1} max={999} className="!w-24" value={r.maxParty} onChange={(e) => setRule(i, "maxParty", Number(e.target.value))} aria-label="max party" /><span className="text-muted">→</span><Input type="number" min={20} max={480} step={5} className="!w-24" value={r.minutes} onChange={(e) => setRule(i, "minutes", Number(e.target.value))} aria-label="minutes" /><span className="text-muted">min</span>
              {rules.length > 1 && <button className="text-bad text-xs ms-auto" onClick={() => setF({ ...f, durationRules: rules.filter((_, j) => j !== i) })}>{t("Remove")}</button>}</div>))}
          <Button size="sm" onClick={() => setF({ ...f, durationRules: [...rules.slice(0, -1), { maxParty: Math.max(...rules.map((r) => r.maxParty < 999 ? r.maxParty : 0), 0) + 2, minutes: 120 }, rules[rules.length - 1]] })}>{t("Add rule")}</Button>
          {fe.durationRules && <p className="text-xs text-bad">{fe.durationRules}</p>}
          <p className="text-xs text-muted">{t("The last rule should be 999 to cover large parties.")}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <Field label={t("Slot interval (min)")} error={fe.slotIntervalMin}><Input min={5} max={120} step={5} {...num("slotIntervalMin")} /></Field>
          <Field label={t("Preparation buffer (min)")} error={fe.bufferMin} hint={t("Kept free after each booking")}><Input min={0} max={120} {...num("bufferMin")} /></Field>
          <Field label={t("Slot hold (min)")} error={fe.holdMinutes} hint={t("While a guest fills the form")}><Input min={1} max={60} {...num("holdMinutes")} /></Field>
          <Field label={t("No-show after (min)")} error={fe.noShowGraceMin}><Input min={0} max={240} {...num("noShowGraceMin")} /></Field>
        </div>
        <Switch checked={f.cleaningWorkflow} onChange={(v) => setF({ ...f, cleaningWorkflow: v })} label={t("“Awaiting cleaning” step")} description={t("On = a table goes to cleaning after a visit and must be marked ready. Off = it becomes available straight away.")} />
        <div className="mt-4"><Button variant="primary" loading={s.saving} onClick={() => save(["durationRules", "slotIntervalMin", "bufferMin", "holdMinutes", "noShowGraceMin", "cleaningWorkflow"], t("Changing durations or buffers affects availability for future bookings. Existing reservations keep their current times."))}>{t("Save timing")}</Button></div>
      </Card>

      <Card>
        <CardHeader title={t("Cancellation & policy")} />
        <div className="space-y-4">
          <Field label={t("Free cancellation deadline (hours before)")} error={fe.cancelDeadlineHours} hint={t("After this guests must call. Also limits online changes.")}><Input min={0} {...num("cancelDeadlineHours")} /></Field>
          <Field label={t("Policy shown to guests")} error={fe.policyText}><Textarea rows={3} value={f.policyText} onChange={(e) => setF({ ...f, policyText: e.target.value })} /></Field>
          <Button variant="primary" loading={s.saving} onClick={() => save(["cancelDeadlineHours", "policyText"])}>{t("Save policy")}</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("Deposits")} action={<Badge tone={deposits ? "ok" : "warn"}>{deposits ? "Pro" : t("Upgrade")}</Badge>} />
        <Notice tone="gold" title={t("Payment processing is not connected")}>{t("Deposits are recorded as “pending” and booked as pending reservations; settle them manually (cash, transfer, card machine) and mark them paid. Online card payment needs a payment-provider adapter (see Integrations).")}</Notice>
        <div className="space-y-4 mt-4">
          <Switch disabled={!deposits} checked={f.depositEnabled} onChange={(v) => setF({ ...f, depositEnabled: v })} label={t("Require a deposit for large online bookings")} />
          <div className="grid grid-cols-2 gap-3"><Field label={t("Amount per guest")} error={fe.depositAmountPerGuest}><Input disabled={!deposits} min={0} step="10" {...num("depositAmountPerGuest")} /></Field><Field label={t("From party size")} error={fe.depositMinParty}><Input disabled={!deposits} min={1} {...num("depositMinParty")} /></Field></div>
          <Button variant="primary" disabled={!deposits} loading={s.saving} onClick={() => save(["depositEnabled", "depositAmountPerGuest", "depositMinParty"], f.depositEnabled ? t("Large online bookings will stay pending until you mark the deposit as received.") : undefined)}>{t("Save deposits")}</Button>
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title={t("Waitlist")} />
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-4">
          <Switch checked={f.waitlistEnabled} onChange={(v) => setF({ ...f, waitlistEnabled: v })} label={t("Enable the waitlist")} />
          <Switch checked={f.publicWaitlistEnabled} onChange={(v) => setF({ ...f, publicWaitlistEnabled: v })} label={t("Let guests join online (digital waitlist page)")} />
          <Field label={t("Priority weight: accessibility needs")} hint={t("Higher = served earlier (0–5)")}><Input type="number" min={0} max={5} value={f.waitlistPriority.accessibility} onChange={(e) => setF({ ...f, waitlistPriority: { ...f.waitlistPriority, accessibility: Number(e.target.value) } })} /></Field>
          <Field label={t("Priority weight: reservation commitment")}><Input type="number" min={0} max={5} value={f.waitlistPriority.reservation_commitment} onChange={(e) => setF({ ...f, waitlistPriority: { ...f.waitlistPriority, reservation_commitment: Number(e.target.value) } })} /></Field>
        </div>
        <div className="mt-4"><Button variant="primary" loading={s.saving} onClick={() => save(["waitlistEnabled", "publicWaitlistEnabled", "waitlistPriority"])}>{t("Save waitlist")}</Button></div>
      </Card>
    </div>
  );
}
