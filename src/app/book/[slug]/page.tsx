import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicRestaurant } from "@/server/availability/public";
import { publicLocale } from "@/lib/i18n/public";
import { I18nProvider } from "@/lib/i18n/client";
import { BookingWidget } from "./widget";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  try { return await getPublicRestaurant(slug); } catch { return null; }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const r = await load((await params).slug);
  if (!r) return { title: "Restaurant not found" };
  return { title: `Book a table — ${r.name}`, description: r.description ?? `Reserve a table at ${r.name}`, openGraph: { title: r.name, description: r.description ?? undefined, images: r.coverUrl ? [r.coverUrl] : undefined } };
}

export default async function BookPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ c?: string }> }) {
  const r = await load((await params).slug);
  if (!r) notFound();
  const locale = await publicLocale(r.locale);
  return <I18nProvider locale={locale}><BookingWidget r={JSON.parse(JSON.stringify(r))} campaignId={(await searchParams).c} /></I18nProvider>;
}
