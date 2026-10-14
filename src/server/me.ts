import { withOrg } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { ROLE_PERMISSIONS, type Permission, type Role } from "@/lib/rbac";
import { getPlanInfo } from "./billing/limits";

export interface Me {
  user: { id: string; email: string; name: string; locale: string };
  organization: { id: string; name: string; status: string; planId: string };
  role: Role;
  permissions: Permission[];
  locationIds: string[] | null;
  features: string[];
  trialEndsAt: string | null;
  locations: Array<{ id: string; name: string; slug: string; timezone: string; currency: string; defaultLocale: string }>;
}

export async function buildMe(ctx: Ctx): Promise<Me> {
  const data = await withOrg(ctx.orgId, async (db) => ({
    locations: await db.query<Me["locations"][number]>(
      `SELECT id, name, slug, timezone, currency, default_locale FROM locations WHERE org_id=$1 AND status='active' AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY name`, [ctx.orgId, ctx.locationIds]),
    plan: await getPlanInfo(db, ctx.orgId),
  }));
  return {
    user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, locale: ctx.user.locale },
    organization: { id: ctx.orgId, name: ctx.org.name, status: ctx.org.status, planId: ctx.org.planId },
    role: ctx.role, permissions: [...ROLE_PERMISSIONS[ctx.role]], locationIds: ctx.locationIds,
    features: data.plan.features, trialEndsAt: data.plan.trialEndsAt ? data.plan.trialEndsAt.toISOString() : null, locations: data.locations,
  };
}
