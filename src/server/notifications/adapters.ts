import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { toHtml } from "./templates";

export type ChannelName = "email" | "sms" | "whatsapp";
export interface OutboundMessage { to: string; subject?: string | null; body: string; idempotencyKey?: string }
export interface SendResult { ok: boolean; providerMessageId?: string; error?: string; retryable?: boolean }

/** Provider adapter contract: core business logic only ever talks to this interface. */
export interface MessageAdapter {
  channel: ChannelName;
  provider: string;
  /** True only when real credentials are present in the environment. */
  isConfigured(): boolean;
  send(msg: OutboundMessage): Promise<SendResult>;
}

let transport: Transporter | null = null;
export const smtpAdapter: MessageAdapter = {
  channel: "email",
  provider: "smtp",
  isConfigured: () => !!env.smtp,
  async send(msg) {
    const cfg = env.smtp;
    if (!cfg) return { ok: false, error: "SMTP is not configured", retryable: false };
    try {
      transport ??= nodemailer.createTransport({
        host: cfg.host, port: cfg.port, secure: cfg.port === 465,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000,
      });
      const info = await transport.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject ?? "", text: msg.body, html: toHtml(msg.body) });
      return { ok: true, providerMessageId: info.messageId };
    } catch (e) {
      transport = null;
      const err = e as { responseCode?: number; message: string };
      // 5xx = permanent rejection (bad mailbox); everything else (network, 4xx) is retryable
      return { ok: false, error: err.message.slice(0, 300), retryable: !(err.responseCode && err.responseCode >= 500) };
    }
  },
};

/** Twilio SMS via REST. Present for convenience; NOT verified against a live account in this repository's tests. */
export const twilioAdapter: MessageAdapter = {
  channel: "sms",
  provider: "twilio",
  isConfigured: () => env.twilioConfigured && !!process.env.TWILIO_FROM,
  async send(msg) {
    if (!this.isConfigured()) return { ok: false, error: "Twilio is not configured", retryable: false };
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID!;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: msg.to, From: process.env.TWILIO_FROM!, Body: msg.body }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) return { ok: false, error: data.message ?? `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
      return { ok: true, providerMessageId: data.sid };
    } catch (e) { return { ok: false, error: (e as Error).message, retryable: true }; }
  },
};

/** WhatsApp Business Cloud API (text messages inside the 24h window / approved templates). NOT verified live here. */
export const whatsappAdapter: MessageAdapter = {
  channel: "whatsapp",
  provider: "whatsapp_cloud",
  isConfigured: () => env.whatsappConfigured,
  async send(msg) {
    if (!this.isConfigured()) return { ok: false, error: "WhatsApp Business is not configured", retryable: false };
    try {
      const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: msg.to.replace("+", ""), type: "text", text: { body: msg.body } }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
      if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
      return { ok: true, providerMessageId: data.messages?.[0]?.id };
    } catch (e) { return { ok: false, error: (e as Error).message, retryable: true }; }
  },
};

const registry: Record<ChannelName, MessageAdapter> = { email: smtpAdapter, sms: twilioAdapter, whatsapp: whatsappAdapter };
let override: Partial<Record<ChannelName, MessageAdapter>> = {};

export const adapterFor = (c: ChannelName): MessageAdapter => override[c] ?? registry[c];
/** Test hook: swap an adapter without touching business logic. */
export function __setAdapterOverride(o: Partial<Record<ChannelName, MessageAdapter>>) { override = o; }

export type IntegrationState = "connected" | "not_configured" | "simulated";
export function channelStatus(c: ChannelName): { provider: string; state: IntegrationState; message: string } {
  const a = adapterFor(c);
  if (a.isConfigured()) return { provider: a.provider, state: "connected", message: "Credentials present. Delivery status is tracked per message." };
  if (env.simulateNotifications) return { provider: "simulator", state: "simulated", message: "No provider connected — messages are recorded as SIMULATED and never leave the server (development mode)." };
  return { provider: a.provider, state: "not_configured", message: "No provider connected — messages are not sent. Configure credentials (see docs/INTEGRATIONS.md)." };
}
