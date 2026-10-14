"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { Button, Field, Input, Notice, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useT } from "@/lib/i18n/client";

function Form() {
  const t = useT(); const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [info, setInfo] = useState<{ email: string; role: string; organization: string; userExists: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(""); const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/auth/invitation?token=${encodeURIComponent(token)}`).then(setInfo).catch((e: ApiError) => setErr(e.message)); }, [token]);
  async function accept(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post("/api/auth/accept-invitation", { token, name: name || undefined, password: pw || undefined }); router.push("/app"); router.refresh(); }
    catch (x) { setErr((x as ApiError).message); setBusy(false); }
  }
  return (
    <AuthCard title={t("Join your team")} subtitle={info ? `${info.organization} · ${info.role.replace("_", " ")}` : undefined} footer={<Link href="/login" className="text-gold-strong font-medium hover:underline">{t("Log in")}</Link>}>
      {!info && !err && <div className="grid place-items-center py-10"><Spinner /></div>}
      {err && <Notice tone="bad">{err}</Notice>}
      {info && (
        <form onSubmit={accept} className="space-y-4">
          <Field label={t("Email")}><Input value={info.email} disabled /></Field>
          {info.userExists
            ? <Notice tone="info">An account already exists for this email. Log in with it first, then open this link again.</Notice>
            : <>
                <Field label={t("Your name")}><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
                <Field label={t("Password")} hint={t("At least 10 characters, with letters and numbers.")}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="new-password" /></Field>
              </>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{info.userExists ? t("Accept invitation") : t("Create account & join")}</Button>
        </form>
      )}
    </AuthCard>
  );
}
export default function Page() { return <Suspense><Form /></Suspense>; }
