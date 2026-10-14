"use client";
import { use, useEffect, useState } from "react";
import { Button, Card, Notice, Spinner, StatusBadge } from "@/components/ui";
import { Icon, Logo } from "@/components/icons";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";

function Status({ token }: { token: string }) {
  const { t } = useI18n();
  const [d, setD] = useState<any>(null); const [err, setErr] = useState<ApiError | null>(null); const [left, setLeft] = useState(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => { const load = () => api.get(`/api/public/waitlist/${token}`).then(setD).catch(setErr); load(); const i = setInterval(load, 20000); return () => clearInterval(i); }, [token]);
  if (err) return <Notice tone="bad">{err.message}</Notice>;
  if (!d) return <div className="grid place-items-center py-12"><Spinner /></div>;
  const active = d.status === "waiting" || d.status === "notified";
  return (
    <Card className="text-center animate-in">
      <div className={`mx-auto size-14 rounded-full grid place-items-center ${d.status === "notified" || d.status === "seated" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}><Icon name={d.status === "notified" || d.status === "seated" ? "check" : "clock"} size={26} /></div>
      <h1 className="text-2xl font-semibold mt-4">{d.status === "notified" ? t("Your table is ready!") : d.status === "seated" ? t("Enjoy your meal") : active ? t("You're on the list") : t("You left the waitlist")}</h1>
      <p className="text-muted mt-1">{d.restaurant} · {d.partySize} {t("guests")}</p>
      <div className="mt-3"><StatusBadge status={d.status} /></div>
      {active && d.status === "waiting" && <div className="mt-5 rounded-xl bg-gold-soft/60 p-4"><p className="text-xs text-muted">{t("Estimated wait")}</p><p className="text-3xl font-semibold tabular text-gold-strong">{d.estimatedWaitMin == null ? "—" : d.estimatedWaitMin === 0 ? t("Any moment") : `~${d.estimatedWaitMin} min`}</p></div>}
      {d.status === "notified" && <p className="mt-4 text-sm text-ink-2">{t("Please check in with the host now.")}</p>}
      <p className="text-xs text-muted mt-4">{d.disclaimer}</p>
      {active && !left && <Button className="mt-5" variant="ghost" onClick={async () => { await api.del(`/api/public/waitlist/${token}`); setLeft(true); setD({ ...d, status: "cancelled" }); }}>{t("Leave the waitlist")}</Button>}
    </Card>
  );
}

export default function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <main className="min-h-dvh bg-canvas grid place-items-center p-5"><div className="w-full max-w-md space-y-6"><div className="flex justify-center"><Logo /></div><Status token={token} /></div></main>;
}
void I18nProvider;
