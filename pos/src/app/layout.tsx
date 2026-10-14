import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = { title: "Comptoir POS", description: "Restaurant point of sale — fast service, accurate bills, honest reports." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1c1b19" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
