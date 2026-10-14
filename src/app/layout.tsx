import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { getLocale } from "@/lib/i18n/server";
import { dirOf } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";
import { FeedbackProvider } from "@/components/feedback";

export const metadata: Metadata = {
  title: { default: "Fluentra — Restaurant reservations & guest management", template: "%s · Fluentra" },
  description: "Reservations, floor plan, waitlist, guest CRM and marketing for restaurants, hotels, rooftops and lounges.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1c1b19" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body>
        <I18nProvider locale={locale}>
          <FeedbackProvider>{children}</FeedbackProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
