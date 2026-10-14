"use client";
import { useState } from "react";
import { Badge, Button, Card, ErrorState, Field, Input, Loading, Notice, Select } from "@/components/ui";
import { AdminShell, DataTable } from "@/components/admin";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { daysAgo, today } from "@/lib/client/format";
import { useT } from "@/lib/i18n";

interface Status {
  settings: { adapter: string; baseUrl: string | null; shareSales: boolean; shareItems: boolean; shareRefunds: boolean; shareKitchen: boolean };
  adapter: { id: string; label: string; isTest: boolean } | null; counts: { pending: number; delivered: number; dead: number; skipped: number };
  oldestPendingAgeSec: number | null; lastDeliveredAt: string | null; errors: Array<Record<string, unknown>>;
}

export default function Integration() { const t = useT(); return <AdminShell title={t("Fluentra sync")}>{(me) => <Inner canConfigure={me.permissions.includes("integration.manage")} />}</AdminShell>; }
function Inner({ canConfigure }: { canConfigure: boolean }) {
  const t = useT();
  const { data, loading, error, reload } = useApi<Status>("/integration/status");
  const inbox = useApi<Array<Record<string, unknown>>>(data?.adapter?.id === "mock" ? "/integration/mock-inbox" : null);
  const [f, setF] = useState<Status["settings"] | null>(null); const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [from, setFrom] = useState(daysAgo(7)); const [to, setTo] = useState(today());
  const s = f ?? data?.settings;
  const guard = async (fn: () => Promise<string | void>) => { setMsg(null); try { const m = await fn(); if (m) setMsg({ tone: "ok", text: m }); await reload(); inbox.reload(); } catch (e) { setMsg({ tone: "bad", text: (e as ApiError).message }); } };
  if (loading) return <Loading />; if (error || !data || !s) return <ErrorState error={error} retry={reload} />;
  return (
    <div className="grid gap-4 max-w-4xl">
      <Notice tone="info" title={t("The POS never waits for Fluentra")}>{t("Every sale is recorded locally first. Events are queued and delivered in the background; if Fluentra is unreachable they wait and retry automatically.")}</Notice>
      {data.adapter?.isTest && <Notice tone="warn" title={t("TEST environment")}>{data.adapter.label}</Notice>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{([["pending", "warn"], ["delivered", "ok"], ["dead", "bad"], ["skipped", "neutral"]] as const).map(([k, tone]) => <Card key={k}><div className="text-sm text-ink-2">{t(k)}</div><div className="text-3xl font-semibold mt-1"><Badge tone={tone} className="text-lg px-3">{data.counts[k]}</Badge></div></Card>)}</div>
      {data.oldestPendingAgeSec !== null && <p className="text-sm text-ink-2">{t("Oldest waiting event")}: {Math.round(data.oldestPendingAgeSec / 60)} min</p>}
      <Card className="grid gap-3">
        <h2 className="font-semibold">{t("Connection")}</h2>
        <Field label={t("Adapter")}><Select disabled={!canConfigure} value={s.adapter} onChange={(e) => setF({ ...s, adapter: e.target.value })}><option value="none">{t("Disabled (events wait in the queue)")}</option><option value="mock">{t("MOCK — test environment only")}</option><option value="http">{t("Fluentra HTTPS endpoint (signed)")}</option></Select></Field>
        {s.adapter === "http" && <Field label={t("Fluentra endpoint URL")} hint={t("https only. The shared secret is set in the server environment (FLUENTRA_SHARED_SECRET), never in the database.")}><Input disabled={!canConfigure} value={s.baseUrl ?? ""} onChange={(e) => setF({ ...s, baseUrl: e.target.value })} placeholder="https://…/api/…/pos/events" /></Field>}
        <div><div className="text-sm font-medium text-ink-2 mb-1">{t("What may leave the POS")}</div>
          {([["shareSales", "Sales totals, orders, payments, cash sessions, day close"], ["shareItems", "Item lines of each order (product mix)"], ["shareRefunds", "Refunds and voids"], ["shareKitchen", "Kitchen delay events"]] as const).map(([k, l]) => <label key={k} className="flex items-center gap-2 py-1"><input type="checkbox" className="size-5" disabled={!canConfigure} checked={s[k]} onChange={(e) => setF({ ...s, [k]: e.target.checked })} />{t(l)}</label>)}</div>
        {canConfigure ? <div><Button onClick={() => guard(async () => { await api("PUT", "/integration/settings", { ...s, baseUrl: s.baseUrl || null }); setF(null); return t("Saved"); })}>{t("Save")}</Button></div> : <p className="text-sm text-muted">{t("Only the owner can change the connection.")}</p>}
      </Card>
      <Card className="grid gap-3"><h2 className="font-semibold">{t("Manual synchronization")}</h2>
        <div className="flex gap-2 flex-wrap items-end"><Field label={t("From")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label={t("To")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Button variant="secondary" onClick={() => guard(async () => { const r = await api<{ requeued: number; backfilled: number }>("POST", "/integration/resync", { from, to }); return `${t("Re-queued")}: ${r.requeued} · ${t("Backfilled")}: ${r.backfilled}`; })}>{t("Re-queue failed + backfill")}</Button>
          <Button variant="secondary" onClick={() => guard(async () => { const r = await api<{ delivered: number; failed: number; dead: number; skipped: number }>("POST", "/integration/dispatch", {}); return `${t("Delivered")}: ${r.delivered} · ${t("Failed")}: ${r.failed} · ${t("Dead")}: ${r.dead} · ${t("Skipped")}: ${r.skipped}`; })}>{t("Deliver now")}</Button></div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}</Card>
      <div><h2 className="font-semibold mb-2">{t("Recent errors")}</h2><DataTable rows={data.errors} columns={["type", "status", "attempts", "lastError", "occurredAt", "nextAttemptAt"]} empty={t("No error")} /></div>
      {data.adapter?.id === "mock" && <div><h2 className="font-semibold mb-2">{t("MOCK Fluentra inbox (test only)")}</h2><DataTable rows={inbox.data?.map((r) => ({ type: r.type, eventId: r.eventId, receivedAt: r.receivedAt })) ?? []} columns={["type", "eventId", "receivedAt"]} /></div>}
    </div>
  );
}
