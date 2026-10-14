"use client";
import { useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { PageHeader, Tabs } from "@/components/ui";
import { useI18n } from "@/lib/i18n/client";
import { LiveFloor } from "./live";
import { Timeline } from "./timeline";
import { Editor } from "./editor";

export default function FloorPage() {
  const { t } = useI18n();
  const { can, locationId } = useApp();
  const [tab, setTab] = useState<"live" | "timeline" | "editor">("live");
  if (!can("floor.view")) return <NoAccess />;
  const tabs = [{ value: "live" as const, label: t("Live service") }, { value: "timeline" as const, label: t("Timeline") }, ...(can("floor.manage") ? [{ value: "editor" as const, label: t("Layout editor") }] : [])];
  return (
    <>
      <PageHeader title={t("Floor plan")} subtitle={t("Seat guests, release tables and see the whole service at a glance.")} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {!locationId ? null : tab === "live" ? <LiveFloor /> : tab === "timeline" ? <Timeline /> : <Editor />}
    </>
  );
}
