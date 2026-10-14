import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { conflict, forbidden, notFound } from "@/lib/errors";
import { getPlanInfo, getUsage, trialExpired } from "./limits";

export async function getBilling(db: Db, ctx: Ctx) {
  const [plan, usage] = await Promise.all([getPlanInfo(db, ctx.orgId), getUsage(db, ctx.orgId)]);
  const plans = await db.query(`SELECT * FROM plans WHERE id <> 'trial' ORDER BY sort`);
  const events = await db.query(`SELECT type, payload, created_at FROM subscription_events WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20`, [ctx.orgId]);
  const simulated = !env.isProd || process.env.ALLOW_SIMULATED_BILLING === "true";
  return {
    plan, usage, plans, events, trialExpired: trialExpired(plan),
    provider: { name: env.stripeConfigured ? "stripe" : "none", state: "not_configured" as const,
      message: simulated ? "No payment provider is connected. Plan changes are SIMULATED: no payment is taken and no invoice is issued." : "Online payment is not connected yet. Contact the platform operator to change your plan." },
    canSelfServe: simulated,
  };
}

export const changePlanSchema = z.object({ planId: z.enum(["starter", "pro", "enterprise"]) });
export async function changePlan(db: Db, ctx: Ctx, input: z.infer<typeof changePlanSchema>) {
  if (!(!env.isProd || process.env.ALLOW_SIMULATED_BILLING === "true")) throw forbidden("Self-service billing is not enabled. Contact support.", "BILLING_NOT_CONFIGURED");
  const target = await db.maybe<{ id: string; maxLocations: number | null; maxUsers: number | null }>(`SELECT id, max_locations, max_users FROM plans WHERE id=$1`, [input.planId]);
  if (!target) throw notFound("Plan");
  const usage = await getUsage(db, ctx.orgId);
  if (target.maxLocations != null && usage.locations > target.maxLocations) throw conflict(`You have ${usage.locations} locations; the ${input.planId} plan allows ${target.maxLocations}. Archive some first.`, "DOWNGRADE_BLOCKED");
  if (target.maxUsers != null && usage.users > target.maxUsers) throw conflict(`You have ${usage.users} users; the ${input.planId} plan allows ${target.maxUsers}. Remove some first.`, "DOWNGRADE_BLOCKED");
  await db.exec(`UPDATE organizations SET plan_id=$2, status='active', trial_ends_at=NULL, billing_provider='simulated', current_period_end = now() + interval '30 days' WHERE id=$1`, [ctx.orgId, input.planId]);
  await db.exec(`INSERT INTO subscription_events (org_id, type, payload) VALUES ($1,'plan_changed_simulated',$2)`, [ctx.orgId, JSON.stringify({ to: input.planId, by: ctx.user.email, note: "Simulated — no payment processed" })]);
  await audit(db, ctx, "billing.plan_change", "organization", ctx.orgId, { to: input.planId, simulated: true });
  return { ok: true, simulated: true };
}
