"use client";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, Notice, Segmented, Select, Skeleton, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useApp } from "@/components/app-shell";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

const KEY_LABEL: Record<string, string> = {
  booking_confirmation: "Booking confirmation", booking_pending: "Request received (pending)", booking_reminder: "Reminder", booking_modified: "Booking modified", booking_cancelled: "Booking cancelled",
  waitlist_joined: "Waitlist joined", waitlist_ready: "Table ready", followup_thanks: "Thank-you after visit", feedback_request: "Feedback request", birthday_greeting: "Birthday greeting", anniversary_greeting: "Anniversary greeting",
};
const CONSENT_KEYS = ["followup_thanks", "feedback_request", "birthday_greeting", "anniversary_greeting"];

export function MessagesTab() {
  const { t } = useI18n();
  return <div className="space-y-6"><Integrations /><Templates /></div>;
  void t;
}

export function Integrations() {
  const { t } = useI18n(); const { can } = useApp(); const { toast } = useFeedback();
  const { data, error } = useApi<{ integrations: any[] }>(can("integrations.manage") ? "/api/v1/integrations" : null);  
  const [busy, setBusy] = useState<string | null>(null);
  if (!can("integrations.manage")) return null;
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-48" />;
  const tone = (s: string) => (s === "connected" ? "ok" : s === "simulated" ? "gold" : "warn") as "ok" | "gold" | "warn";
  async function test(kind: string) {
    setBusy(kind);
    try { const r = await api.post(`/api/v1/integrations/${kind}/test`, {}); (r.ok ? toast.success : toast.info)(r.message); } catch (e) { toast.error(e); } finally { setBusy(null); }
  }
  return (
    <Card>
      <CardHeader title={t("Integrations")} subtitle={t("Status of every external provider. Nothing is reported as delivered unless a real provider confirms it.")} />
      <ul className="divide-y divide-line">
        {data.integrations.map((i) => (
          <li key={i.kind} className="py-4 flex flex-wrap gap-x-6 gap-y-2 items-start">
            <div className="w-44"><p className="font-medium">{i.label}</p><Badge tone={tone(i.state)} dot className="mt-1">{i.state === "connected" ? t("Connected") : i.state === "simulated" ? t("Simulated (dev)") : t("Not configured")}</Badge></div>
            <div className="flex-1 min-w-64 text-sm"><p className="text-ink-2">{i.message}</p><p className="text-xs text-muted mt-1.5 flex gap-1.5"><Icon name="info" size={14} className="mt-0.5" /><span><b>{t("How to configure")}:</b> {i.configure}</span></p></div>
            {["email", "sms", "whatsapp"].includes(i.kind) && <Button size="sm" loading={busy === i.kind} onClick={() => test(i.kind)}>{t("Send test")}</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Templates() {
  const { t } = useI18n(); const { toast, confirm } = useFeedback();
  const { data, error, reload } = useApi<{ templates: any[]; variables: string[] }>("/api/v1/templates");  
  const [key, setKey] = useState("booking_confirmation"); const [channel, setChannel] = useState("email"); const [locale, setLocale] = useState("fr");
  const cur = useMemo(() => data?.templates.find((x) => x.key === key && x.channel === channel && x.locale === locale), [data, key, channel, locale]);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [preview, setPreview] = useState<{ subject: string | null; body: string } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur) { setSubject(cur.subject ?? ""); setBody(cur.body); } }, [cur]);
  useEffect(() => { if (!body) return; const h = setTimeout(() => api.post("/api/v1/templates/preview", { body, subject: channel === "email" ? subject : null }).then(setPreview).catch(() => setPreview(null)), 300); return () => clearTimeout(h); }, [body, subject, channel]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-96" />;
  const dirty = cur && (cur.body !== body || (channel === "email" && (cur.subject ?? "") !== subject));
  async function save() { setBusy(true); try { await api.put("/api/v1/templates", { key, channel, locale, subject: channel === "email" ? subject : null, body }); toast.success(t("Template saved")); reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } }
  async function reset() { if (!(await confirm({ title: t("Reset to default?"), message: t("Your customized text for this template will be replaced by the default."), confirmLabel: t("Reset") }))) return; await api.del(`/api/v1/templates?key=${key}&channel=${channel}&locale=${locale}`); toast.success(t("Template reset")); reload(); }
  return (
    <Card>
      <CardHeader title={t("Message templates")} subtitle={t("One template per message type, channel and language. Guests receive the language of their profile.")} />
      <div className="flex flex-wrap gap-2 mb-4">
        <Select value={key} onChange={(e) => setKey(e.target.value)} className="!w-auto" aria-label={t("Template")}>{Object.entries(KEY_LABEL).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</Select>
        <Segmented value={channel} onChange={setChannel} options={[{ value: "email", label: "Email" }, { value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp" }]} />
        <Segmented value={locale} onChange={setLocale} options={[{ value: "fr", label: "FR" }, { value: "en", label: "EN" }, { value: "ar", label: "AR" }]} />
        {cur?.customized && <Badge tone="gold">{t("Customized")}</Badge>}
      </div>
      {CONSENT_KEYS.includes(key) && <div className="mb-4"><Notice tone="info">{t("This message type is only sent to guests who gave marketing consent for the channel, and the unsubscribe link is required.")}</Notice></div>}
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="space-y-3">
          {channel === "email" && <Field label={t("Subject")}><Input value={subject} onChange={(e) => setSubject(e.target.value)} dir={locale === "ar" ? "rtl" : "ltr"} /></Field>}
          <Field label={t("Message")}><Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} dir={locale === "ar" ? "rtl" : "ltr"} /></Field>
          <div className="flex flex-wrap gap-1.5">{data.variables.map((v) => <button key={v} type="button" onClick={() => setBody(body + `{{${v}}}`)} className="text-xs rounded-md bg-sunken hover:bg-line px-2 py-1 font-mono">{`{{${v}}}`}</button>)}</div>
          <div className="flex gap-2"><Button variant="primary" loading={busy} disabled={!dirty || !body.trim()} onClick={save}>{t("Save template")}</Button>{cur?.customized && <Button onClick={reset}>{t("Reset to default")}</Button>}</div>
        </div>
        <div><p className="text-[13px] font-medium text-ink-2 mb-1.5">{t("Preview (sample data)")}</p>
          <div className="rounded-xl border border-line bg-canvas p-4 text-sm whitespace-pre-wrap" dir={locale === "ar" ? "rtl" : "ltr"}>{preview?.subject && <p className="font-semibold mb-2">{preview.subject}</p>}{preview?.body}</div>
          <p className="text-xs text-muted mt-2">{channel !== "email" ? t("Keep SMS and WhatsApp messages short — long messages are split and cost more.") : t("Emails are sent as plain text with clickable links.")} · {body.length} {t("characters")}</p></div>
      </div>
    </Card>
  );
}
