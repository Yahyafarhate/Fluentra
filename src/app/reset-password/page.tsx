"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useT } from "@/lib/i18n/client";

function Form() {
  const t = useT(); const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.post("/api/auth/reset-password", { token, password: pw }); router.push("/login?reset=1"); } catch (x) { setError((x as ApiError).message); setBusy(false); }
  }
  return (
    <AuthCard title={t("Choose a new password")} footer={<Link href="/login" className="text-gold-strong font-medium hover:underline">{t("Back to log in")}</Link>}>
      <form onSubmit={submit} className="space-y-4">
        {!token && <Notice tone="bad">This link is incomplete. Request a new one.</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label={t("New password")} hint={t("At least 10 characters, with letters and numbers.")}><Input type="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!token}>{t("Update password")}</Button>
      </form>
    </AuthCard>
  );
}
export default function Page() { return <Suspense><Form /></Suspense>; }
