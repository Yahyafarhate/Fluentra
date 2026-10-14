import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicReservation } from "@/server/reservations/service";
import { publicLocale } from "@/lib/i18n/public";
import { I18nProvider } from "@/lib/i18n/client";
import { ManageReservation } from "./manage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your reservation", robots: { index: false, follow: false } };

export default async function Page({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ new?: string }> }) {
  const { token } = await params;
  let r;
  try { r = await getPublicReservation(token); } catch { notFound(); }
  const locale = await publicLocale(r.restaurant.locale);
  return <I18nProvider locale={locale}><ManageReservation token={token} initial={JSON.parse(JSON.stringify(r))} justBooked={(await searchParams).new === "1"} /></I18nProvider>;
}
