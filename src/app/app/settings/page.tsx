"use client";
import { useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { PageHeader, Tabs } from "@/components/ui";
import { useI18n } from "@/lib/i18n/client";
import { ProfileTab } from "./profile";
import { HoursTab } from "./hours";
import { BookingTab } from "./booking";
import { MessagesTab } from "./messages";
import { PrivacyTab, AuditTab, LocationsTab } from "./org";

export default function SettingsPage() {
  const { t } = useI18n();
  const { can, locationId } = useApp();
  const [tab, setTab] = useState("profile");
  if (!can("settings.manage")) return <NoAccess />;
  const tabs = [
    { value: "profile", label: t("Restaurant") }, { value: "hours", label: t("Hours & holidays") }, { value: "booking", label: t("Booking rules") },
    ...(can("automations.manage") ? [{ value: "messages", label: t("Messages & integrations") }] : []),
    { value: "locations", label: t("Locations") }, { value: "privacy", label: t("Data & privacy") },
    ...(can("audit.view") ? [{ value: "audit", label: t("Audit log") }] : []),
  ];
  return (
    <>
      <PageHeader title={t("Settings")} subtitle={t("Everything is validated on the server and recorded in the audit log.")} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {!locationId && tab !== "privacy" ? null : tab === "profile" ? <ProfileTab /> : tab === "hours" ? <HoursTab /> : tab === "booking" ? <BookingTab /> : tab === "messages" ? <MessagesTab /> : tab === "locations" ? <LocationsTab /> : tab === "privacy" ? <PrivacyTab /> : <AuditTab />}
    </>
  );
}
