"use client";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, Notice, Select, Skeleton, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useApp } from "@/components/app-shell";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { useLocationSettings } from "./use-location";

const ZONES = ["Africa/Casablanca", "Europe/Paris", "Europe/London", "Europe/Madrid", "Africa/Tunis", "Africa/Algiers", "Africa/Cairo", "Asia/Dubai", "Asia/Riyadh", "America/New_York", "UTC"];

export function ProfileTab() {
  const { t } = useI18n();
  const { hasFeature, locationId } = useApp();
  const { toast } = useFeedback();
  const s = useLocationSettings();
  const [f, setF] = useState<any>(null);  
  const file = useRef<HTMLInputElement>(null); const kind = useRef<"logo" | "cover" | "gallery">("logo"); const [up, setUp] = useState<string | null>(null);
  useEffect(() => { const l = s.loc; if (l) setF({ name: l.name, address: l.address ?? "", city: l.city ?? "", country: l.country, phone: l.phone ?? "", email: l.email ?? "", website: l.website ?? "", description: l.description ?? "", timezone: l.timezone, defaultLocale: l.defaultLocale, brandColor: l.brandColor, currency: l.currency }); }, [s.loc]);
  if (s.error && !s.loc) return <ErrorState error={s.error} />;
  if (!f) return <Skeleton className="h-96" />;
  const fe = s.error?.fields ?? {};
  const branded = hasFeature("custom_branding");
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file0 = e.target.files?.[0]; if (!file0) return; setUp(kind.current);
    try {
      const res = await fetch(`/api/v1/locations/${locationId}/upload?kind=${kind.current}`, { method: "POST", body: file0, headers: { "Content-Type": file0.type } });
      const j = await res.json(); if (!res.ok) throw new Error(j.error?.message ?? "Upload failed");
      toast.success(t("Image uploaded")); s.reload();
    } catch (x) { toast.error((x as Error).message); } finally { setUp(null); e.target.value = ""; }
  }
  const pick = (k: typeof kind.current) => { kind.current = k; file.current?.click(); };
  const l = s.loc;
  return (
    <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6">
      <Card>
        <CardHeader title={t("Restaurant profile")} subtitle={t("Shown on your public booking page and in guest messages.")} />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label={t("Name")} error={fe.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t("Phone")} error={fe.phone}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={t("Address")} className="sm:col-span-2" error={fe.address}><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label={t("City")}><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <Field label={t("Country (ISO code)")} error={fe.country}><Input value={f.country} maxLength={2} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
          <Field label={t("Public email")} error={fe.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t("Website")} error={fe.website}><Input type="url" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://" /></Field>
          <Field label={t("Description")} className="sm:col-span-2" error={fe.description}><Textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label={t("Time zone")} hint={t("Used for service dates, reports and reminders.")}><Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{[...new Set([f.timezone, ...ZONES])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
          <Field label={t("Booking page language")}><Select value={f.defaultLocale} onChange={(e) => setF({ ...f, defaultLocale: e.target.value })}><option value="fr">Français</option><option value="en">English</option><option value="ar">العربية</option></Select></Field>
          <Field label={t("Currency")} error={fe.currency}><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label={t("Brand color")} error={fe.brandColor}><div className="flex gap-2"><input type="color" value={f.brandColor} onChange={(e) => setF({ ...f, brandColor: e.target.value })} disabled={!branded} className="h-10 w-14 rounded-lg border border-line-strong bg-surface p-1" aria-label={t("Brand color")} /><Input value={f.brandColor} onChange={(e) => setF({ ...f, brandColor: e.target.value })} disabled={!branded} /></div></Field>
        </div>
        {!branded && <div className="mt-4"><Notice tone="gold">{t("Custom branding (logo, cover photo and brand color) is available on the Pro plan and above.")}</Notice></div>}
        <div className="mt-5"><Button variant="primary" loading={s.saving} onClick={() => s.patch({ ...f, email: f.email || null, website: f.website || null, ...(branded ? {} : { brandColor: undefined }) })}>{t("Save restaurant profile")}</Button></div>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("Branding")} subtitle={t("PNG, JPEG or WebP, up to 2 MB.")} action={<Badge tone={branded ? "ok" : "warn"}>{branded ? "Pro" : t("Upgrade")}</Badge>} />
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={upload} />
          <div className="space-y-4">
            {(["logo", "cover"] as const).map((k) => (
              <div key={k} className="flex items-center gap-4">
                <div className={`${k === "logo" ? "size-16 rounded-xl" : "h-16 w-28 rounded-xl"} bg-sunken border border-line grid place-items-center overflow-hidden shrink-0`}>{l?.[k === "logo" ? "logoUrl" : "coverUrl"] ? <img src={l[k === "logo" ? "logoUrl" : "coverUrl"]} alt="" className="w-full h-full object-cover" /> : <Icon name="upload" className="text-muted" />}</div>
                <div className="flex-1"><p className="text-sm font-medium">{k === "logo" ? t("Logo") : t("Cover photo")}</p><Button size="sm" className="mt-1" disabled={!branded} loading={up === k} onClick={() => pick(k)}>{t("Upload")}</Button></div>
              </div>
            ))}
            <div><p className="text-sm font-medium mb-2">{t("Gallery")}</p><div className="flex flex-wrap gap-2">{(l?.gallery ?? []).map((u: string) => <img key={u} src={u} alt="" className="size-16 rounded-lg object-cover border border-line" />)}<button disabled={!branded} onClick={() => pick("gallery")} className="size-16 rounded-lg border-2 border-dashed border-line-strong grid place-items-center text-muted hover:text-ink disabled:opacity-40" aria-label={t("Add photo")}><Icon name="plus" /></button></div></div>
          </div>
        </Card>
        <Card><CardHeader title={t("Your public booking page")} />
          <p className="text-sm text-ink-2 mb-3">{t("Share this link on Instagram, Google Business Profile, your website and WhatsApp.")}</p>
          {l && <div className="flex gap-2"><Input readOnly value={`${typeof window !== "undefined" ? window.location.origin : ""}/book/${l.slug}`} onFocus={(e) => e.currentTarget.select()} aria-label="Booking link" /><Button icon="copy" aria-label={t("Copy")} onClick={async () => { await navigator.clipboard?.writeText(`${window.location.origin}/book/${l.slug}`); toast.success(t("Link copied")); }} /></div>}
          {l && <a className="text-sm text-gold-strong underline mt-3 inline-block" target="_blank" rel="noreferrer" href={`/book/${l.slug}`}>{t("Open the page")}</a>}
        </Card>
      </div>
    </div>
  );
}
