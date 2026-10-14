"use client";
import { use, useState } from "react";
import { Button, Card, Notice } from "@/components/ui";
import { Logo } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";

export default function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params); const t = useT();
  const [done, setDone] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function go() { setBusy(true); try { await api.post("/api/public/unsubscribe", { token }); setDone(true); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); } }
  return (
    <main className="min-h-dvh bg-canvas grid place-items-center p-5"><div className="w-full max-w-md space-y-6"><div className="flex justify-center"><Logo /></div>
      <Card className="text-center">{done ? <><h1 className="text-2xl font-semibold">{t("You're unsubscribed")}</h1><p className="text-muted mt-2">{t("You will no longer receive marketing messages on this channel. Booking confirmations and reminders for your reservations are not affected.")}</p></> :
        <><h1 className="text-2xl font-semibold">{t("Unsubscribe from marketing messages?")}</h1><p className="text-muted mt-2">{t("We'll stop sending news and offers to you on this channel.")}</p>{err && <div className="mt-3"><Notice tone="bad">{err}</Notice></div>}<Button className="mt-5" variant="primary" size="lg" loading={busy} onClick={go}>{t("Yes, unsubscribe")}</Button></>}</Card></div></main>
  );
}
