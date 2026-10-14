"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, PageHeader, Select, Skeleton, Switch } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { useLocationSettings } from "../settings/use-location";

export default function OnboardingPage() {
  const { t } = useI18n();
  const { can, locationId, me } = useApp();
  const { toast } = useFeedback();
  const s = useLocationSettings();
  const floor = useApi<any>(locationId ? `/api/v1/floor/state?locationId=${locationId}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [step, setStep] = useState(0);
  const [p, setP] = useState({ name: "", address: "", city: "", phone: "", description: "" });
  const [hours, setHours] = useState<Array<{ id?: string; name: string; startTime: string; lastSeating: string; days: number[]; active: boolean }>>([]);
  const [layout, setLayout] = useState({ twos: 6, fours: 6, sixes: 2 }); const [rules, setRules] = useState({ autoConfirm: true, maxPartyOnline: 8, cancelDeadlineHours: 4 });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (s.loc) { setP({ name: s.loc.name, address: s.loc.address ?? "", city: s.loc.city ?? "", phone: s.loc.phone ?? "", description: s.loc.description ?? "" }); setRules({ autoConfirm: s.loc.autoConfirm, maxPartyOnline: s.loc.maxPartyOnline, cancelDeadlineHours: s.loc.cancelDeadlineHours }); setHours(s.services.map((x: any) => ({ id: x.id, name: x.name, startTime: x.startTime, lastSeating: x.lastSeating, days: x.days, active: x.active }))); } }, [s.loc, s.services.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!can("settings.manage")) return <NoAccess />;
  if (!s.loc) return <Skeleton className="h-96" />;
  const tableCount = floor.data?.tables?.length ?? 0;
  const steps = [t("Restaurant"), t("Opening hours"), t("Tables"), t("Booking rules"), t("Go live")];

  async function saveProfile() { setBusy(true); setErr(null); if (await s.patch({ name: p.name, address: p.address || null, city: p.city || null, phone: p.phone || null, description: p.description || null }, t("Profile saved"))) setStep(1); setBusy(false); }
  async function saveHours() {
    setBusy(true); setErr(null);
    try { for (const h of hours) await api.put(`/api/v1/services/${h.id}`, { locationId, name: h.name, days: h.days, startTime: h.startTime, lastSeating: h.lastSeating, active: h.active }); toast.success(t("Opening hours saved")); setStep(2); s.reload(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  async function generate() {
    setBusy(true); setErr(null);
    try {
      const st = floor.data; const fl = st.floors[0]; const sec = st.sections[0]?.id ?? null; let n = tableCount;
      const mk = async (cap: number, count: number, w: number, h: number, shape: string, row: number) => { for (let i = 0; i < count; i++) { n++; await api.post("/api/v1/floor/tables", { locationId, floorId: fl.id, sectionId: sec, name: `T${n}`, capacity: cap, shape, w, h, x: 40 + (i % 7) * 130, y: 40 + row * 170 + Math.floor(i / 7) * 150 }); } };
      await mk(2, layout.twos, 80, 70, "rect", 0); await mk(4, layout.fours, 110, 80, "rect", 1); await mk(6, layout.sixes, 170, 90, "rect", 2);
      toast.success(t("Tables created — fine-tune them in the Floor plan editor")); floor.reload(); setStep(3);
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  async function saveRules() { setBusy(true); if (await s.patch(rules, t("Booking rules saved"))) setStep(4); setBusy(false); }
  const dayAbbr = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const fe = s.error?.fields ?? {};

  return (
    <>
      <PageHeader title={t("Set up your restaurant")} subtitle={t("Five quick steps to take your first online reservation.")} />
      <ol className="flex flex-wrap gap-2 mb-6">{steps.map((l, i) => <li key={l}><button onClick={() => setStep(i)} className={`flex items-center gap-2 rounded-full px-3.5 h-9 text-sm border ${i === step ? "bg-charcoal text-white border-charcoal" : i < step ? "bg-ok-soft border-ok/30 text-ok" : "bg-surface border-line-strong text-muted"}`}><span className="size-5 rounded-full bg-white/20 grid place-items-center text-xs">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>{l}</button></li>)}</ol>
      <Card className="max-w-3xl">
        {step === 0 && <div className="space-y-4"><CardHeader title={t("About your restaurant")} />
          <Field label={t("Name")} error={fe.name}><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <div className="grid sm:grid-cols-2 gap-4"><Field label={t("Address")}><Input value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} /></Field><Field label={t("City")}><Input value={p.city} onChange={(e) => setP({ ...p, city: e.target.value })} /></Field></div>
          <Field label={t("Phone")} error={fe.phone}><Input value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
          <Field label={t("Short description")}><Input value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} /></Field>
          <Button variant="primary" loading={busy} onClick={saveProfile}>{t("Save & continue")}</Button></div>}
        {step === 1 && <div className="space-y-4"><CardHeader title={t("When are you open?")} subtitle={t("Last seating is the latest time a party can be seated. Add more services or holidays later in Settings.")} />
          {hours.map((h, i) => <div key={h.id} className="rounded-xl border border-line p-4 space-y-3"><div className="flex items-center justify-between"><b>{h.name}</b><Switch checked={h.active} onChange={(v) => setHours(hours.map((x, j) => (j === i ? { ...x, active: v } : x)))} label={t("Active")} /></div>
            <div className="grid grid-cols-2 gap-3"><Field label={t("Opens")}><Input type="time" value={h.startTime} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)))} /></Field><Field label={t("Last seating")}><Input type="time" value={h.lastSeating} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, lastSeating: e.target.value } : x)))} /></Field></div>
            <div className="flex flex-wrap gap-1.5">{dayAbbr.map((d, k) => <button key={d} type="button" aria-pressed={h.days.includes(k + 1)} onClick={() => setHours(hours.map((x, j) => (j === i ? { ...x, days: x.days.includes(k + 1) ? x.days.filter((y) => y !== k + 1) : [...x.days, k + 1].sort() } : x)))} className={`h-8 px-2.5 rounded-lg text-sm border ${h.days.includes(k + 1) ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{d}</button>)}</div></div>)}
          {err && <Notice tone="bad">{err.message}</Notice>}
          <div className="flex gap-2"><Button onClick={() => setStep(0)}>{t("Back")}</Button><Button variant="primary" loading={busy} onClick={saveHours}>{t("Save & continue")}</Button></div></div>}
        {step === 2 && <div className="space-y-4"><CardHeader title={t("Your tables")} subtitle={tableCount ? t("You already have {n} tables. Add more here or fine-tune the layout in the Floor plan editor.", { n: tableCount }) : t("Generate a starting layout now; you can drag, resize and rename everything afterwards.")} />
          <div className="grid grid-cols-3 gap-3"><Field label={t("Tables for 2")}><Input type="number" min={0} max={40} value={layout.twos} onChange={(e) => setLayout({ ...layout, twos: Number(e.target.value) })} /></Field><Field label={t("Tables for 4")}><Input type="number" min={0} max={40} value={layout.fours} onChange={(e) => setLayout({ ...layout, fours: Number(e.target.value) })} /></Field><Field label={t("Tables for 6")}><Input type="number" min={0} max={40} value={layout.sixes} onChange={(e) => setLayout({ ...layout, sixes: Number(e.target.value) })} /></Field></div>
          {err && <Notice tone="bad">{err.message}</Notice>}
          <div className="flex flex-wrap gap-2"><Button onClick={() => setStep(1)}>{t("Back")}</Button><Button variant="primary" loading={busy} disabled={!floor.data || layout.twos + layout.fours + layout.sixes === 0} onClick={generate}>{t("Create tables")}</Button>{tableCount > 0 && <Button onClick={() => setStep(3)}>{t("Skip")}</Button>}<Link href="/app/floor" className="ms-auto"><Button variant="ghost" icon="floor">{t("Open the editor")}</Button></Link></div></div>}
        {step === 3 && <div className="space-y-4"><CardHeader title={t("Booking rules")} subtitle={t("Sensible defaults — everything is adjustable in Settings → Booking rules.")} />
          <Switch checked={rules.autoConfirm} onChange={(v) => setRules({ ...rules, autoConfirm: v })} label={t("Confirm online bookings automatically")} />
          <div className="grid grid-cols-2 gap-3"><Field label={t("Largest party bookable online")}><Input type="number" min={1} value={rules.maxPartyOnline} onChange={(e) => setRules({ ...rules, maxPartyOnline: Number(e.target.value) })} /></Field><Field label={t("Free cancellation until (hours before)")}><Input type="number" min={0} value={rules.cancelDeadlineHours} onChange={(e) => setRules({ ...rules, cancelDeadlineHours: Number(e.target.value) })} /></Field></div>
          <div className="flex gap-2"><Button onClick={() => setStep(2)}>{t("Back")}</Button><Button variant="primary" loading={busy} onClick={saveRules}>{t("Save & continue")}</Button></div></div>}
        {step === 4 && <div className="space-y-4"><CardHeader title={t("You're ready 🎉")} />
          <ul className="space-y-2 text-sm"><li className="flex gap-2"><Icon name="check" className="text-ok" />{t("Restaurant profile saved")}</li><li className="flex gap-2"><Icon name="check" className="text-ok" />{t("{n} service period(s) configured", { n: s.services.filter((x: { active: boolean }) => x.active).length })}</li><li className="flex gap-2"><Icon name={tableCount ? "check" : "alert"} className={tableCount ? "text-ok" : "text-warn"} />{t("{n} tables", { n: tableCount })}</li></ul>
          <Notice tone="info" title={t("Your booking page")}>{typeof window !== "undefined" && `${window.location.origin}/book/${s.loc.slug}`}</Notice>
          <div className="flex flex-wrap gap-2"><a href={`/book/${s.loc.slug}`} target="_blank" rel="noreferrer"><Button variant="primary" icon="link">{t("Open booking page")}</Button></a><Link href="/app/dashboard"><Button>{t("Go to dashboard")}</Button></Link><Link href="/app/team"><Button icon="users">{t("Invite your team")}</Button></Link></div></div>}
      </Card>
      {me.organization.status === "trial" && <p className="text-xs text-muted mt-4">{t("You are on a free trial.")} <Badge tone="gold">14 days</Badge></p>}
    </>
  );
}
void Select;
