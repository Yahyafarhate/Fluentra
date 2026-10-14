"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Card, Field, Input, Logo, Notice } from "@/components/ui";
import { authCall, ApiError } from "@/lib/client/api";
import { useT } from "@/lib/i18n";

export default function AdminLogin() {
  const t = useT();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await authCall("POST", "/login", { email, password }); window.location.href = "/admin"; }
    catch (x) { setErr((x as ApiError).message); setBusy(false); }
  }
  return (
    <main className="min-h-dvh grid place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center"><Logo /></div>
        <Card>
          <h1 className="text-xl font-semibold mb-4">{t("Back office")}</h1>
          <form onSubmit={submit} className="grid gap-3">
            <Field label={t("Email")}><Input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label={t("Password")}><Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            {err && <Notice tone="bad">{err}</Notice>}
            <Button type="submit" disabled={busy}>{t("Sign in")}</Button>
          </form>
          <p className="text-sm text-muted mt-4"><Link className="underline" href="/pos/login">{t("POS terminal sign-in")}</Link> · <Link className="underline" href="/signup">{t("Create organization")}</Link></p>
        </Card>
      </div>
    </main>
  );
}
