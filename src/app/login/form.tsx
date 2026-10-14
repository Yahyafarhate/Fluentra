"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useT } from "@/lib/i18n/client";

const DEMO = [
  ["owner@atlas.demo", "Owner"], ["gm@atlas.demo", "General manager"], ["manager@atlas.demo", "Restaurant manager"], ["host@atlas.demo", "Host"],
  ["service@atlas.demo", "Service"], ["marketing@atlas.demo", "Marketing"], ["admin@fluentra.dev", "Platform admin"], ["owner@medina.demo", "Other tenant"],
];

export function LoginForm({ showDemo }: { showDemo: boolean }) {
  const t = useT();
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ isSuperAdmin: boolean }>("/api/auth/login", { email, password });
      router.push(r.isSuperAdmin ? "/admin" : next && next.startsWith("/app") ? next : "/app"); router.refresh();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); setBusy(false); }
  }
  return (
    <AuthCard title={t("Welcome back")} subtitle={t("Log in to manage your restaurant.")} footer={<>{t("New to Fluentra?")} <Link href="/signup" className="text-gold-strong font-medium hover:underline">{t("Start a free trial")}</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label={t("Email")}><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field label={t("Password")}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div className="text-end -mt-1"><Link href="/forgot-password" className="text-sm text-muted hover:text-ink">{t("Forgot your password?")}</Link></div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{t("Log in")}</Button>
      </form>
      {showDemo && (
        <details className="mt-8 rounded-xl border border-dashed border-line-strong p-4 text-sm">
          <summary className="cursor-pointer font-medium text-ink-2">{t("Demo accounts (development only)")}</summary>
          <p className="text-xs text-muted mt-2">Password for all: <code className="bg-sunken px-1.5 py-0.5 rounded">Demo-Pass-2026</code></p>
          <ul className="mt-2 grid gap-1">
            {DEMO.map(([e, r]) => <li key={e}><button type="button" className="w-full text-start rounded-md px-2 py-1 hover:bg-sunken flex justify-between" onClick={() => { setEmail(e); setPassword("Demo-Pass-2026"); }}><span>{e}</span><span className="text-muted">{r}</span></button></li>)}
          </ul>
        </details>
      )}
    </AuthCard>
  );
}
