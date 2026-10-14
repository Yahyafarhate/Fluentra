"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PublicShell, type PublicRestaurant } from "@/components/public-shell";
import { Button, Card, Field, Input, Notice, Switch } from "@/components/ui";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";

export function JoinWaitlist({ r }: { r: PublicRestaurant }) {
  const { t } = useI18n(); const router = useRouter();
  const [f, setF] = useState({ name: "", phone: "", partySize: 2, sms: false, website: "" }); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const res = await api.post(`/api/public/restaurants/${r.slug}/waitlist`, { name: f.name, phone: f.phone, partySize: f.partySize, consent: f.sms ? { sms: true, whatsapp: true } : undefined, website: f.website }); router.push(res.statusUrl); }
    catch (x) { setErr(x as ApiError); setBusy(false); }
  }
  const fe = err?.fields ?? {};
  return (
    <PublicShell r={r} narrow>
      <Card className="animate-in">
        <h2 className="text-2xl font-semibold">{t("Join the waitlist")}</h2>
        <p className="text-sm text-ink-2 mt-1">{t("No table right now? Leave your details and we'll let you know when one is ready.")}</p>
        <div className="mt-4"><Notice tone="gold" title={t("Estimates, not promises")}>{t("Waiting times are estimates based on current availability and are not guaranteed.")}</Notice></div>
        {!r.waitlistOpen ? <div className="mt-4"><Notice tone="warn">{t("The online waitlist is not open right now. Please speak to the host.")}</Notice></div> : (
          <form onSubmit={go} className="mt-5 space-y-4" noValidate>
            <Field label={t("Your name")} error={fe.name} required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
            <div className="grid grid-cols-2 gap-3"><Field label={t("Mobile phone")} error={fe.phone} required><Input type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></Field>
              <Field label={t("Guests")}><div className="flex items-center gap-2"><Button aria-label="−" onClick={() => setF({ ...f, partySize: Math.max(1, f.partySize - 1) })}>−</Button><span className="flex-1 text-center font-semibold">{f.partySize}</span><Button aria-label="+" onClick={() => setF({ ...f, partySize: Math.min(r.maxPartyOnline, f.partySize + 1) })}>+</Button></div></Field></div>
            <div className="hidden" aria-hidden="true"><input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></div>
            <Switch checked={f.sms} onChange={(v) => setF({ ...f, sms: v })} label={t("Message me by SMS / WhatsApp when my table is ready")} />
            {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!f.name.trim() || !f.phone.trim()}>{t("Add me to the waitlist")}</Button>
          </form>
        )}
      </Card>
    </PublicShell>
  );
}
