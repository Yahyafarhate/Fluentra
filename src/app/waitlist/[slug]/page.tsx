import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicRestaurant } from "@/server/availability/public";
import { publicLocale } from "@/lib/i18n/public";
import { I18nProvider } from "@/lib/i18n/client";
import { JoinWaitlist } from "./join";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join the waitlist" };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  let r;
  try { r = await getPublicRestaurant((await params).slug); } catch { notFound(); }
  const locale = await publicLocale(r.locale);
  return <I18nProvider locale={locale}><JoinWaitlist r={JSON.parse(JSON.stringify(r))} /></I18nProvider>;
}
