"use client";
import { use, useEffect, useState } from "react";
import { Button, Card, Notice, Spinner, Textarea } from "@/components/ui";
import { Logo } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";

export default function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params); const t = useT();
  const [info, setInfo] = useState<{ restaurant: string; alreadySubmitted: boolean } | null>(null); const [err, setErr] = useState<string | null>(null);
  const [rating, setRating] = useState(0); const [comment, setComment] = useState(""); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/public/feedback/${token}`).then(setInfo).catch((e: ApiError) => setErr(e.message)); }, [token]);
  async function send() { setBusy(true); try { await api.post(`/api/public/feedback/${token}`, { rating, comment: comment || undefined }); setDone(true); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); } }
  return (
    <main className="min-h-dvh bg-canvas grid place-items-center p-5"><div className="w-full max-w-md space-y-6"><div className="flex justify-center"><Logo /></div>
      {err && <Notice tone="bad">{err}</Notice>}{!info && !err && <div className="grid place-items-center py-10"><Spinner /></div>}
      {info && (done || info.alreadySubmitted ? <Card className="text-center"><h1 className="text-2xl font-semibold">{t("Thank you!")}</h1><p className="text-muted mt-2">{t("Your feedback helps {name} improve.", { name: info.restaurant })}</p></Card> : (
        <Card><h1 className="text-2xl font-semibold text-center">{t("How was your visit to {name}?", { name: info.restaurant })}</h1>
          <div className="flex justify-center gap-1 my-6" role="radiogroup" aria-label={t("Rating")}>{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n}/5`} onClick={() => setRating(n)} className={`text-4xl transition ${n <= rating ? "text-gold" : "text-line-strong hover:text-gold/60"}`}>★</button>)}</div>
          <Textarea rows={3} placeholder={t("Tell us more (optional)")} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1500} />
          <Button className="w-full mt-4" variant="primary" size="lg" disabled={!rating} loading={busy} onClick={send}>{t("Send feedback")}</Button></Card>))}</div></main>
  );
}
