"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/client";

export default function SignupPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [f, setF] = useState({ organizationName: "", restaurantName: "", city: "", ownerName: "", email: "", password: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post("/api/auth/signup", { ...f, city: f.city || undefined, locale }); router.push("/app/onboarding"); router.refresh(); }
    catch (x) { setErr(x as ApiError); setBusy(false); }
  }
  const fe = err?.fields ?? {};
  return (
    <AuthCard wide title={t("Start your 14-day trial")} subtitle={t("No credit card required. Set up your first restaurant in minutes.")} footer={<>{t("Already have an account?")} <Link href="/login" className="text-gold-strong font-medium hover:underline">{t("Log in")}</Link></>}>
      <form onSubmit={submit} className="grid sm:grid-cols-2 gap-4" noValidate>
        {err && !Object.keys(fe).length && <div className="sm:col-span-2"><Notice tone="bad">{err.message}</Notice></div>}
        <Field label={t("Business name")} error={fe.organizationName} required><Input value={f.organizationName} onChange={set("organizationName")} placeholder="Atlas Hospitality" /></Field>
        <Field label={t("First restaurant")} error={fe.restaurantName} required><Input value={f.restaurantName} onChange={set("restaurantName")} placeholder="Le Riad" /></Field>
        <Field label={t("City")}><Input value={f.city} onChange={set("city")} placeholder="Casablanca" /></Field>
        <Field label={t("Your name")} error={fe.ownerName} required><Input value={f.ownerName} onChange={set("ownerName")} autoComplete="name" /></Field>
        <Field label={t("Email")} error={fe.email} required className="sm:col-span-2"><Input type="email" value={f.email} onChange={set("email")} autoComplete="email" /></Field>
        <Field label={t("Password")} error={fe.password} hint={t("At least 10 characters, with letters and numbers.")} required className="sm:col-span-2"><Input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" /></Field>
        <div className="sm:col-span-2"><Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{t("Create my account")}</Button></div>
      </form>
    </AuthCard>
  );
}
void Select;
