"use client";
import Link from "next/link";
import { Button, Card, ErrorState, Loading, LangSwitch, Logo } from "@/components/ui";
import { signOut, useMe } from "@/components/pos-shell";
import { useApi } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

export default function KdsHome() {
  const t = useT(); const me = useMe();
  const { data, error, loading, reload } = useApi<Array<{ id: string; name: string; kind: string; targetSeconds: number }>>(me?.outletId ? `/outlets/${me.outletId}/stations` : null);
  return (
    <main className="min-h-dvh bg-charcoal text-white p-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6"><Logo /><div className="flex items-center gap-2"><LangSwitch />{me?.permissions.includes("orders.create") && <Link href="/pos"><Button variant="ghost" size="sm" className="text-white">POS</Button></Link>}<Button variant="ghost" size="sm" className="text-white" onClick={() => signOut()}>{t("Lock")}</Button></div></div>
        <h1 className="text-2xl font-semibold mb-4">{t("Choose a station")}</h1>
        {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : <div className="grid sm:grid-cols-3 gap-3">{data?.map((s) => <Link key={s.id} href={`/kds/${s.id}`}><Card className="bg-charcoal-2 border-white/10 text-white hover:border-gold"><div className="text-xl font-semibold">{s.name}</div><div className="text-sm text-white/60 mt-1">{t(s.kind)} · {t("target")} {Math.round(s.targetSeconds / 60)} min</div></Card></Link>)}</div>}
      </div>
    </main>
  );
}
