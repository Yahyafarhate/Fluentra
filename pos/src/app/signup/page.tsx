"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, Field, Input, Logo, Notice } from "@/components/ui";
import { authCall, ApiError } from "@/lib/client/api";
import { useT } from "@/lib/i18n";

export default function Signup() {
  const t = useT();
  const [f, setF] = useState({ organizationName: "", outletName: "", ownerName: "", email: "", password: "", pin: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ terminalCode: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setDone(await authCall("POST", "/signup", { ...f, pin: f.pin || undefined })); } catch (x) { setErr(x as ApiError); } finally { setBusy(false); }
  }
  const field = (path: string) => (err?.details as Array<{ path: string; message: string }> | undefined)?.find((d) => d.path === path)?.message;

  return (
    <main className="min-h-dvh grid place-items-center p-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex justify-center"><Logo /></div>
        {done ? (
          <Card>
            <h1 className="text-2xl font-semibold">{t("Your organization is ready")}</h1>
            <p className="mt-2 text-ink-2">{t("Write down your terminal code: servers enter it once on each POS device.")}</p>
            <div className="my-4 rounded-xl bg-charcoal text-gold text-center py-4 text-3xl tracking-[.3em] font-mono">{done.terminalCode}</div>
            <div className="flex gap-2 flex-wrap"><Link href="/admin/login"><Button>{t("Open the back office")}</Button></Link><Link href="/pos/login"><Button variant="secondary">{t("Open the POS")}</Button></Link></div>
          </Card>
        ) : (
          <Card>
            <h1 className="text-2xl font-semibold mb-4">{t("Create your organization")}</h1>
            <form onSubmit={submit} className="grid gap-3">
              <Field label={t("Organization name")} error={field("organizationName")}><Input required value={f.organizationName} onChange={set("organizationName")} /></Field>
              <Field label={t("First outlet name")} error={field("outletName")}><Input required value={f.outletName} onChange={set("outletName")} /></Field>
              <Field label={t("Your name")} error={field("ownerName")}><Input required value={f.ownerName} onChange={set("ownerName")} /></Field>
              <Field label={t("Email")} error={field("email")}><Input type="email" required value={f.email} onChange={set("email")} autoComplete="email" /></Field>
              <Field label={t("Password")} hint={t("At least 10 characters, with letters and numbers")} error={field("password")}><Input type="password" required value={f.password} onChange={set("password")} autoComplete="new-password" /></Field>
              <Field label={t("POS PIN (4 to 8 digits)")} hint={t("Optional — lets you also sign in on the POS terminal")} error={field("pin")}><Input inputMode="numeric" pattern="\d{4,8}" value={f.pin} onChange={set("pin")} /></Field>
              {err && !field("email") && !field("password") && <Notice tone="bad">{err.message}</Notice>}
              <Button type="submit" disabled={busy} size="lg">{busy ? t("Creating…") : t("Create")}</Button>
            </form>
          </Card>
        )}
      </div>
    </main>
  );
}
