"use client";
import { useState } from "react";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useT } from "@/lib/i18n/client";

export default function Page() {
  const t = useT();
  const [email, setEmail] = useState(""); const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ devLink?: string } | null>(null); const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { setDone(await api.post("/api/auth/forgot-password", { email })); } catch (x) { setError((x as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <AuthCard title={t("Reset your password")} subtitle={t("We'll email you a link to choose a new one.")} footer={<Link href="/login" className="text-gold-strong font-medium hover:underline">{t("Back to log in")}</Link>}>
      {done ? (
        <div className="space-y-3">
          <Notice tone="ok" title={t("Check your inbox")}>{t("If an account exists for that address, a reset link is on its way. It is valid for one hour.")}</Notice>
          {done.devLink && <Notice tone="gold" title="Development mode">No email provider is connected, so the link is shown here: <Link className="underline break-all" href={done.devLink}>{done.devLink}</Link></Notice>}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Notice tone="bad">{error}</Notice>}
          <Field label={t("Email")}><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{t("Send reset link")}</Button>
        </form>
      )}
    </AuthCard>
  );
}
