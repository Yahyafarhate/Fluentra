import type { Db } from "@/lib/db";
import { planLimit, forbidden } from "@/lib/errors";

export type Feature = "crm" | "waitlist" | "analytics" | "analytics_export" | "automations" | "marketing" | "multi_location" | "custom_branding" | "deposits" | "forecasting" | "api";

export interface PlanInfo {
  orgId: string; planId: string; planName: string; status: string; trialEndsAt: Date | null;
  maxLocations: number | null; maxUsers: number | null; maxMonthlyReservations: number | null; features: string[];
}

export async function getPlanInfo(db: Db, orgId: string): Promise<PlanInfo> {
  return db.one<PlanInfo>(
    `SELECT o.id AS org_id, o.plan_id, p.name AS plan_name, o.status, o.trial_ends_at,
            p.max_locations, p.max_users, p.max_monthly_reservations, p.features
       FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`, [orgId]);
}

export const trialExpired = (p: Pick<PlanInfo, "status" | "trialEndsAt">) => p.status === "trial" && !!p.trialEndsAt && p.trialEndsAt < new Date();

export async function hasFeature(db: Db, orgId: string, f: Feature): Promise<boolean> {
  return (await getPlanInfo(db, orgId)).features.includes(f);
}

/** Server-side feature gate. Hiding UI is never enough: every gated endpoint calls this. */
export async function requireFeature(db: Db, orgId: string, f: Feature) {
  const p = await getPlanInfo(db, orgId);
  if (!p.features.includes(f)) throw forbidden(`Your ${p.planName} plan does not include this feature. Upgrade to unlock it.`, "FEATURE_NOT_IN_PLAN");
}

export async function getUsage(db: Db, orgId: string) {
  return db.one<{ locations: number; users: number; reservationsThisMonth: number }>(
    `SELECT (SELECT count(*) FROM locations WHERE org_id=$1 AND status='active')::int AS locations,
            (SELECT count(*) FROM memberships WHERE org_id=$1 AND status='active')::int
              + (SELECT count(*) FROM invitations WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > now())::int AS users,
            (SELECT count(*) FROM reservations WHERE org_id=$1 AND created_at >= date_trunc('month', now()))::int AS reservations_this_month`, [orgId]);
}

export async function assertWithinPlan(db: Db, orgId: string, kind: "locations" | "users" | "reservations") {
  const [plan, usage] = await Promise.all([getPlanInfo(db, orgId), getUsage(db, orgId)]);
  if (kind === "reservations" && trialExpired(plan)) {
    throw planLimit("The trial period has ended. Choose a plan to keep taking reservations.", { code: "TRIAL_EXPIRED" });
  }
  const limit = kind === "locations" ? plan.maxLocations : kind === "users" ? plan.maxUsers : plan.maxMonthlyReservations;
  const used = kind === "locations" ? usage.locations : kind === "users" ? usage.users : usage.reservationsThisMonth;
  if (limit != null && used >= limit) {
    throw planLimit(`Plan limit reached: your ${plan.planName} plan allows ${limit} ${kind === "reservations" ? "reservations per month" : kind}. Upgrade to add more.`, { limit, used, kind });
  }
}
