"use client";
import { useApp } from "@/components/app-shell";
import { useApi } from "@/lib/client/hooks";
import { api, ApiError } from "@/lib/client/api";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { useState } from "react";

/** Loads full location settings and offers a validated patch function. */
export function useLocationSettings() {
  const { locationId } = useApp();
  const { toast } = useFeedback();
  const { t } = useI18n();
  const q = useApi<any>(locationId ? `/api/v1/locations/${locationId}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function patch(body: Record<string, unknown>, ok = t("Settings saved")): Promise<boolean> {
    setSaving(true); setError(null);
    try { await api.patch(`/api/v1/locations/${locationId}`, body); toast.success(ok); await q.reload(); return true; }
    catch (e) { setError(e as ApiError); toast.error(e); return false; } finally { setSaving(false); }
  }
  return { ...q, locationId, saving, error, patch, loc: q.data?.location, services: q.data?.services ?? [], specialDays: q.data?.specialDays ?? [] };
}
