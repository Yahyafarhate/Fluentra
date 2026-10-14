import { adapterFor } from "./adapters";
import { DEFAULT_TEMPLATES, render, type Locale } from "./templates";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

/** Account-level emails (password reset, invitations) are not tenant notifications; they bypass the notification ledger. */
export async function sendSystemEmail(o: { to: string; template: "password_reset" | "invitation"; vars: Record<string, string>; locale?: string }) {
  const locale = (["fr", "en", "ar"].includes(o.locale ?? "") ? o.locale : "fr") as Locale;
  const t = DEFAULT_TEMPLATES[o.template][locale];
  const subject = render(t.subject, o.vars);
  const body = render(t.body, o.vars);
  const adapter = adapterFor("email");
  if (!adapter.isConfigured()) {
    if (!env.isProd) log.info("system email (not sent — SMTP not configured, development mode)", { template: o.template, subject });
    else log.warn("system email NOT sent: SMTP not configured", { template: o.template });
    return { sent: false };
  }
  const r = await adapter.send({ to: o.to, subject, body });
  if (!r.ok) log.error("system email failed", { template: o.template, error: r.error });
  return { sent: r.ok };
}
