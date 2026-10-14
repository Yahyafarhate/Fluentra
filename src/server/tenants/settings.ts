import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { channelStatus, adapterFor, type ChannelName } from "../notifications/adapters";
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, TEMPLATE_VARS, render, LOCALES } from "../notifications/templates";
import { env } from "@/lib/env";

export async function listTemplates(db: Db, ctx: Ctx) {
  const overrides = await db.query<{ key: string; channel: string; locale: string; subject: string | null; body: string; active: boolean }>(`SELECT key, channel, locale, subject, body, active FROM notification_templates WHERE org_id=$1`, [ctx.orgId]);
  const out = [];
  for (const key of TEMPLATE_KEYS) for (const locale of LOCALES) {
    const def = DEFAULT_TEMPLATES[key][locale];
    for (const channel of ["email", "sms", "whatsapp"] as const) {
      const o = overrides.find((x) => x.key === key && x.locale === locale && x.channel === channel);
      out.push({ key, locale, channel, subject: o?.subject ?? def.subject, body: o?.body ?? def.body, customized: !!o, active: o?.active ?? true });
    }
  }
  return { templates: out, variables: TEMPLATE_VARS };
}

export const templateSchema = z.object({
  key: z.enum(TEMPLATE_KEYS), channel: z.enum(["email", "sms", "whatsapp"]), locale: z.enum(["fr", "en", "ar"]),
  subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(2000),
});
export async function saveTemplate(db: Db, ctx: Ctx, t: z.infer<typeof templateSchema>) {
  await db.exec(
    `INSERT INTO notification_templates (org_id, key, channel, locale, subject, body) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id, key, channel, locale) DO UPDATE SET subject=EXCLUDED.subject, body=EXCLUDED.body, updated_at=now()`, [ctx.orgId, t.key, t.channel, t.locale, t.subject ?? null, t.body]);
  await audit(db, ctx, "template.save", "notification_template", `${t.key}/${t.channel}/${t.locale}`);
}
export async function resetTemplate(db: Db, ctx: Ctx, key: string, channel: string, locale: string) {
  await db.exec(`DELETE FROM notification_templates WHERE org_id=$1 AND key=$2 AND channel=$3 AND locale=$4`, [ctx.orgId, key, channel, locale]);
  await audit(db, ctx, "template.reset", "notification_template", `${key}/${channel}/${locale}`);
}
export const previewTemplate = (body: string, subject?: string | null) => {
  const vars = { guest_name: "Samira Benali", restaurant: "Le Riad Atlas", date: "samedi 18 octobre", time: "20:00", party_size: 4, code: "K7M2QX", manage_link: "https://app.example/r/…", address: "12 Bd de la Corniche, Casablanca", policy: "Annulation gratuite jusqu'à 4h avant.", feedback_link: "https://app.example/feedback/…", unsubscribe_link: "https://app.example/u/…", wait_minutes: 25 };
  return { subject: subject ? render(subject, vars) : null, body: render(body, vars) };
};

/** Honest integration overview: what is connected, simulated or not configured, and how to configure it. */
export function integrationOverview() {
  return [
    { kind: "email", label: "Email", ...channelStatus("email"), configure: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in the server environment.", verified: adapterFor("email").isConfigured() ? "Adapter implemented; delivery receipts need a provider webhook (/api/webhooks/delivery)." : null },
    { kind: "sms", label: "SMS", ...channelStatus("sms"), configure: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM. Adapter is implemented but has not been verified against a live Twilio account.", verified: null },
    { kind: "whatsapp", label: "WhatsApp Business", ...channelStatus("whatsapp"), configure: "Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID (Meta Cloud API). Approved templates are required for business-initiated messages. Not verified against a live account.", verified: null },
    { kind: "payments", label: "Payments / deposits", provider: "none", state: env.stripeConfigured ? "not_configured" : "not_configured", message: "No payment provider adapter is connected. Deposits are recorded as 'pending' and must be settled manually.", configure: "Stripe / CMI adapters are planned (see docs/INTEGRATIONS.md).", verified: null },
    { kind: "pos", label: "POS", provider: "none", state: "not_configured", message: "No POS integration. Spend is entered manually per visit; revenue figures reflect recorded spend only.", configure: "POS adapters are planned (see docs/INTEGRATIONS.md).", verified: null },
  ];
}

export async function sendTestMessage(db: Db, ctx: Ctx, channel: ChannelName, to?: string) {
  const adapter = adapterFor(channel);
  const target = to ?? (channel === "email" ? ctx.user.email : undefined);
  if (!target) throw notFound("Recipient");
  if (!adapter.isConfigured()) {
    await audit(db, ctx, "integration.test", "integration", channel, { simulated: true });
    return { ok: false, simulated: env.simulateNotifications, message: env.simulateNotifications ? "No provider is connected. In development mode this would be recorded as SIMULATED; nothing was sent." : "No provider is connected for this channel; nothing was sent." };
  }
  const r = await adapter.send({ to: target, subject: "Fluentra test message", body: "This is a test message from Fluentra. If you received it, delivery works." });
  await audit(db, ctx, "integration.test", "integration", channel, { ok: r.ok });
  return { ok: r.ok, simulated: false, message: r.ok ? "Test message handed to the provider." : `Provider error: ${r.error}` };
}

export async function listAudit(db: Db, ctx: Ctx, opts: { limit?: number; before?: number; action?: string } = {}) {
  return db.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at, a.actor_label, a.ip
       FROM audit_logs a WHERE a.org_id=$1 AND ($2::bigint IS NULL OR a.id < $2) AND ($3::text IS NULL OR a.action LIKE $3 || '%') ORDER BY a.id DESC LIMIT $4`,
    [ctx.orgId, opts.before ?? null, opts.action ?? null, Math.min(opts.limit ?? 100, 500)]);
}
