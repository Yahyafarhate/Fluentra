"use client";
import { useEffect, useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, StatusBadge, Switch, Tabs, TableWrap, Td, Th } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

const TRIGGER_LABEL: Record<string, string> = {
  reservation_created: "Reservation created", reservation_confirmed: "Reservation confirmed", reservation_modified: "Reservation modified", reservation_cancelled: "Reservation cancelled",
  reminder_before: "Reminder before arrival", visit_completed: "After the visit", feedback_request: "Feedback request after visit", birthday: "Guest birthday", anniversary: "Guest anniversary", waitlist_ready: "Waitlist: table ready",
};
const TEMPLATES = ["booking_confirmation", "booking_pending", "booking_reminder", "booking_modified", "booking_cancelled", "waitlist_ready", "followup_thanks", "feedback_request", "birthday_greeting", "anniversary_greeting"];
const TIMED = ["reminder_before", "visit_completed", "feedback_request", "birthday", "anniversary"];

function timing(trigger: string, off: number, t: (k: string, v?: Record<string, string | number>) => string) {
  if (!TIMED.includes(trigger)) return t("immediately");
  const abs = Math.abs(off); const v = abs % 1440 === 0 ? abs / 1440 : abs % 60 === 0 ? abs / 60 : abs; const u = abs % 1440 === 0 ? t("day(s)") : abs % 60 === 0 ? t("hour(s)") : t("min");
  if (trigger === "birthday" || trigger === "anniversary") return off === 0 ? t("on the day") : off < 0 ? t("{v} {u} before", { v, u }) : t("{v} {u} after", { v, u });
  return off === 0 ? t("at the time") : off < 0 ? t("{v} {u} before", { v, u }) : t("{v} {u} after", { v, u });
}

export default function AutomationsPage() {
  const { t } = useI18n();
  const { can } = useApp();
  const [tab, setTab] = useState("rules");
  if (!can("automations.manage")) return <NoAccess />;
  return (
    <>
      <PageHeader title={t("Automations & messages")} subtitle={t("Rules decide what is sent and when. Every run, retry and failure is recorded.")} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "rules", label: t("Rules") }, { value: "log", label: t("Message log") }]} />
      {tab === "rules" ? <Rules /> : <Log />}
    </>
  );
}

function Rules() {
  const { t, fmt } = useI18n(); const { toast, confirm } = useFeedback();
  const { data, error, loading, reload } = useApi<any>("/api/v1/automations"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [open, setOpen] = useState<string | null>(null); const [dlg, setDlg] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  async function toggle(id: string, enabled: boolean) { try { await api.patch(`/api/v1/automations/${id}`, { enabled }); toast.success(enabled ? t("Rule enabled") : t("Rule disabled")); reload(); } catch (e) { toast.error(e); } }
  async function del(r: { id: string; name: string }) { if (!(await confirm({ title: t("Delete “{name}”?", { name: r.name }), tone: "danger", confirmLabel: t("Delete") }))) return; try { await api.del(`/api/v1/automations/${r.id}`); toast.success(t("Deleted")); reload(); } catch (e) { toast.error(e); } }
  return (
    <>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap"><Notice tone="info">{t("Built-in rules send transactional messages. Rules marked “needs consent” only reach guests who agreed to marketing messages.")}</Notice>
        <Button variant="primary" icon="plus" disabled={data && !data.canCreateCustom} onClick={() => setDlg(true)}>{t("New rule")}</Button></div>
      {data && !data.canCreateCustom && <div className="mb-4"><Notice tone="gold">{t("Custom automation rules are a Pro feature. Built-in rules remain active.")}</Notice></div>}
      {loading && <Skeleton className="h-64" />}
      <ul className="space-y-3">{data?.rules.map((r: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
        <li key={r.id}><Card className="!p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Switch checked={r.enabled} onChange={(v) => toggle(r.id, v)} />
            <div className="min-w-0 flex-1"><p className="font-semibold flex items-center gap-2 flex-wrap">{r.name}{r.isSystem && <Badge>{t("Built-in")}</Badge>}</p>
              <p className="text-xs text-muted mt-0.5">{t(TRIGGER_LABEL[r.trigger])} · {timing(r.trigger, r.offsetMinutes, t)} · <span className="capitalize">{r.channel}</span>{r.conditions?.fallbackChannel ? ` (${t("falls back to")} ${r.conditions.fallbackChannel})` : ""} · {t(r.templateKey.replace(/_/g, " "))}</p></div>
            <div className="text-xs text-muted text-end">{r.runs} {t("runs")}{r.failures > 0 && <span className="text-bad"> · {r.failures} {t("failed")}</span>}{r.lastRun && <div>{t("last")} {fmt.date(r.lastRun, { dateStyle: "short", timeStyle: "short" })}</div>}</div>
            <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? t("Hide history") : t("History")}</Button>{!r.isSystem && <Button size="sm" variant="ghost" className="!text-bad" onClick={() => del(r)}>{t("Delete")}</Button>}</div>
          </div>
          {open === r.id && <RunHistory ruleId={r.id} />}
        </Card></li>))}</ul>
      <RuleDialog open={dlg} onClose={() => setDlg(false)} onDone={() => { setDlg(false); reload(); }} triggers={data?.triggers ?? []} />
    </>
  );
}

function RunHistory({ ruleId }: { ruleId: string }) {
  const { t, fmt } = useI18n();
  const { data, error } = useApi<any[]>(`/api/v1/automations/${ruleId}/runs`); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-24 mt-3" />;
  if (!data.length) return <p className="text-sm text-muted mt-4">{t("No executions yet.")}</p>;
  return (
    <div className="mt-4"><TableWrap><thead><tr><Th>{t("When")}</Th><Th>{t("Status")}</Th><Th>{t("Recipient")}</Th><Th>{t("Detail")}</Th></tr></thead>
      <tbody>{data.map((r) => <tr key={r.id}><Td className="text-xs whitespace-nowrap tabular">{fmt.date(r.createdAt, { dateStyle: "short", timeStyle: "short" })}</Td><Td><StatusBadge status={r.status} /></Td><Td className="text-xs">{r.toAddress ? maskAddr(r.toAddress) : "—"}</Td><Td className="text-xs text-muted max-w-sm">{r.status === "simulated" && <span className="text-gold-strong font-medium">SIMULATED · </span>}{r.detail}{r.error ? ` — ${r.error}` : ""}{r.attempts > 1 ? ` (${r.attempts} ${t("attempts")})` : ""}</Td></tr>)}</tbody></TableWrap></div>
  );
}
const maskAddr = (a: string) => (a.includes("@") ? a.replace(/^(.).*(@.*)$/, "$1•••$2") : a.replace(/\d(?=\d{3})/g, "•"));

function RuleDialog({ open, onClose, onDone, triggers }: { open: boolean; onClose: () => void; onDone: () => void; triggers: string[] }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const blank = { name: "", trigger: "reminder_before", amount: 24, unit: "60", when: "before", channel: "email", templateKey: "booking_reminder", minPartySize: "", vipOnly: false, maxAttempts: 3, enabled: true };
  const [f, setF] = useState(blank); const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (open) { setF(blank); setErr(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const timed = TIMED.includes(f.trigger);
  async function go() {
    const mins = Number(f.amount) * Number(f.unit) * (f.when === "before" ? -1 : 1);
    const conditions: Record<string, unknown> = {}; if (f.minPartySize) conditions.minPartySize = Number(f.minPartySize); if (f.vipOnly) conditions.vipOnly = true;
    try { await api.post("/api/v1/automations", { name: f.name, trigger: f.trigger, offsetMinutes: timed ? mins : 0, conditions, channel: f.channel, templateKey: f.templateKey, enabled: f.enabled, maxAttempts: f.maxAttempts }); toast.success(t("Rule created")); onDone(); } catch (e) { setErr(e as ApiError); }
  }
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={t("New automation rule")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" disabled={!f.name.trim()} onClick={go}>{t("Create rule")}</Button></>}>
      <div className="grid sm:grid-cols-2 gap-4 pt-1">
        <Field label={t("Rule name")} className="sm:col-span-2" error={err?.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t("e.g. VIP reminder")} /></Field>
        <Field label={t("Trigger")}><Select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>{triggers.map((x) => <option key={x} value={x}>{t(TRIGGER_LABEL[x])}</option>)}</Select></Field>
        {timed ? <Field label={t("Timing")}><div className="flex gap-2"><Input type="number" min={0} className="!w-20" value={f.amount} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} /><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}><option value="60">{t("hours")}</option><option value="1440">{t("days")}</option><option value="1">{t("minutes")}</option></Select><Select value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })}><option value="before">{t("before")}</option><option value="after">{t("after")}</option></Select></div></Field> : <Field label={t("Timing")}><Input disabled value={t("Immediately when it happens")} /></Field>}
        <Field label={t("Channel")}><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></Select></Field>
        <Field label={t("Message template")} hint={t("Edit the wording in Settings → Messages.")}><Select value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })}>{TEMPLATES.map((x) => <option key={x} value={x}>{t(x.replace(/_/g, " "))}</option>)}</Select></Field>
        <Field label={t("Condition: party size at least")}><Input type="number" min={1} value={f.minPartySize} onChange={(e) => setF({ ...f, minPartySize: e.target.value })} /></Field>
        <Field label={t("Retry attempts")} hint={t("With increasing delay if the provider fails temporarily.")}><Input type="number" min={1} max={10} value={f.maxAttempts} onChange={(e) => setF({ ...f, maxAttempts: Number(e.target.value) })} /></Field>
        <div className="sm:col-span-2 flex gap-6"><Switch checked={f.vipOnly} onChange={(v) => setF({ ...f, vipOnly: v })} label={t("VIP guests only")} /><Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={t("Enabled")} /></div>
        {err && !err.fields.name && <div className="sm:col-span-2"><Notice tone="bad">{err.message}</Notice></div>}
      </div>
    </Dialog>
  );
}

function Log() {
  const { t, fmt } = useI18n();
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useApi<any>(`/api/v1/notifications${qs({ status: status || undefined })}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const c = data?.counts;
  return (
    <>
      {c && <div className="flex flex-wrap gap-2 mb-4">{([["", "All"], ["sent", "Sent"], ["delivered", "Delivered"], ["simulated", "Simulated"], ["queued", "Queued"], ["failed", "Failed"], ["skipped", "Skipped"]] as const).map(([k, l]) => <button key={k} onClick={() => setStatus(k)} className={`rounded-full px-3 h-8 text-sm border ${status === k ? "bg-charcoal text-white border-charcoal" : "bg-surface border-line-strong hover:bg-sunken"}`}>{t(l)}{k && c[k] !== undefined ? <span className="opacity-60"> {c[k]}</span> : null}</button>)}</div>}
      {c?.simulated > 0 && <div className="mb-4"><Notice tone="gold" title={t("Some messages are SIMULATED")}>{t("No provider is connected, so these were recorded but never left the server. Connect a provider in Settings → Messages & integrations.")}</Notice></div>}
      {loading && <Skeleton className="h-64" />}
      {data && data.notifications.length === 0 && <Card><EmptyState icon="message" title={t("No messages yet")}>{t("Confirmations, reminders and campaigns will be listed here with their delivery status.")}</EmptyState></Card>}
      {data && data.notifications.length > 0 && <TableWrap><thead><tr><Th>{t("When")}</Th><Th>{t("Message")}</Th><Th>{t("Channel")}</Th><Th>{t("To")}</Th><Th>{t("Status")}</Th><Th>{t("Detail")}</Th></tr></thead>
        <tbody>{data.notifications.map((n: any) => <tr key={n.id}><Td className="text-xs whitespace-nowrap tabular">{fmt.date(n.createdAt, { dateStyle: "short", timeStyle: "short" })}</Td><Td className="text-sm">{t(n.templateKey.replace(/_/g, " "))}</Td><Td className="capitalize text-sm">{n.channel}</Td><Td className="text-xs">{maskAddr(n.toAddress)}</Td><Td><StatusBadge status={n.status} label={n.status === "simulated" ? "SIMULATED" : undefined} /></Td><Td className="text-xs text-muted max-w-xs truncate">{n.error ?? (n.attempts > 1 ? `${n.attempts} ${t("attempts")}` : "")}</Td></tr>)}</tbody></TableWrap>}
    </>
  );
}
void Icon;
