import { z } from "zod";
import { withSystem } from "@/lib/db";
import type { SuperCtx } from "@/lib/auth";
import { hashPassword, validatePasswordStrength } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { conflict, notFound, badRequest } from "@/lib/errors";
import { jobStats } from "../notifications/jobs";
import { channelStatus } from "../notifications/adapters";
import { seedDefaultAutomations } from "../automation/service";
import { createLocationWithDefaults, uniqueSlug } from "../tenants/signup";
import { env } from "@/lib/env";

const asActor = (s: SuperCtx) => ({ orgId: null as never, user: s.user });

export async function listOrganizations(q?: string) {
  return withSystem((db) => db.query(
    `SELECT o.id, o.name, o.slug, o.status, o.plan_id, o.trial_ends_at, o.suspended_at, o.suspended_reason, o.created_at,
            (SELECT count(*) FROM locations l WHERE l.org_id=o.id AND l.status='active')::int AS locations,
            (SELECT count(*) FROM memberships m WHERE m.org_id=o.id AND m.status='active')::int AS users,
            (SELECT count(*) FROM reservations r WHERE r.org_id=o.id AND r.created_at >= date_trunc('month', now()))::int AS reservations_this_month,
            (SELECT max(created_at) FROM audit_logs a WHERE a.org_id=o.id) AS last_activity
       FROM organizations o WHERE ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%' OR o.slug ILIKE '%' || $1 || '%') ORDER BY o.created_at DESC LIMIT 200`, [q ?? null]));
}

export const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(100), restaurantName: z.string().trim().min(2).max(100), planId: z.enum(["starter", "pro", "enterprise"]).default("pro"),
  trialDays: z.number().int().min(0).max(120).default(14), ownerName: z.string().trim().min(2).max(100), ownerEmail: z.string().trim().toLowerCase().email(), ownerPassword: z.string().min(10).max(200),
  city: z.string().trim().max(80).optional(),
});
export async function createOrganization(s: SuperCtx, input: z.infer<typeof createOrgSchema>) {
  validatePasswordStrength(input.ownerPassword);
  const hash = await hashPassword(input.ownerPassword);
  return withSystem(async (db) => {
    if (await db.maybe(`SELECT 1 FROM users WHERE email=$1`, [input.ownerEmail])) throw conflict("A user with this email already exists", "EMAIL_TAKEN");
    const slug = await uniqueSlug(db, "organizations", input.name);
    const org = await db.one<{ id: string }>(
      `INSERT INTO organizations (name, slug, plan_id, status, trial_ends_at) VALUES ($1,$2,$3,$4, CASE WHEN $5 > 0 THEN now() + make_interval(days => $5) END) RETURNING id`,
      [input.name, slug, input.planId, input.trialDays > 0 ? "trial" : "active", input.trialDays]);
    const user = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`, [input.ownerEmail, hash, input.ownerName]);
    await db.exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, user.id]);
    await createLocationWithDefaults(db, org.id, { name: input.restaurantName, city: input.city });
    await seedDefaultAutomations(db, org.id);
    await audit(db, asActor(s), "admin.org_create", "organization", org.id, { plan: input.planId }, { orgId: org.id });
    return { id: org.id, slug };
  });
}

export async function getOrganizationDetail(id: string) {
  return withSystem(async (db) => {
    const org = await db.maybe(`SELECT o.*, p.name AS plan_name FROM organizations o JOIN plans p ON p.id=o.plan_id WHERE o.id=$1`, [id]);
    if (!org) throw notFound("Organization");
    const [locations, members, usage, failed, audits, events] = await Promise.all([
      db.query(`SELECT id, name, slug, status, online_booking_enabled FROM locations WHERE org_id=$1 ORDER BY name`, [id]),
      db.query(`SELECT m.id, m.role, m.status, u.name, u.email, u.last_login_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.created_at`, [id]),
      db.one(`SELECT (SELECT count(*) FROM reservations WHERE org_id=$1)::int AS reservations_total, (SELECT count(*) FROM reservations WHERE org_id=$1 AND created_at >= date_trunc('month', now()))::int AS reservations_month,
                     (SELECT count(*) FROM customers WHERE org_id=$1)::int AS customers, (SELECT count(*) FROM notifications WHERE org_id=$1)::int AS notifications`, [id]),
      db.query(`SELECT id, template_key, channel, error, created_at FROM notifications WHERE org_id=$1 AND status='failed' ORDER BY created_at DESC LIMIT 10`, [id]),
      db.query(`SELECT id, action, actor_label, metadata, created_at FROM audit_logs WHERE org_id=$1 ORDER BY id DESC LIMIT 25`, [id]),
      db.query(`SELECT type, payload, created_at FROM subscription_events WHERE org_id=$1 ORDER BY created_at DESC LIMIT 10`, [id]),
    ]);
    return { org, locations, members, usage, failedNotifications: failed, audit: audits, subscriptionEvents: events };
  });
}

export const orgPatchSchema = z.object({
  planId: z.enum(["starter", "pro", "enterprise", "trial"]).optional(),
  status: z.enum(["trial", "active", "past_due"]).optional(),
  extendTrialDays: z.number().int().min(1).max(120).optional(),
  name: z.string().trim().min(2).max(100).optional(),
});
export async function updateOrganization(s: SuperCtx, id: string, patch: z.infer<typeof orgPatchSchema>) {
  return withSystem(async (db) => {
    const cur = await db.maybe<{ status: string }>(`SELECT status FROM organizations WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur) throw notFound("Organization");
    if (cur.status === "suspended" && patch.status) throw conflict("Reactivate the account first", "ORG_SUSPENDED");
    await db.exec(
      `UPDATE organizations SET plan_id=COALESCE($2,plan_id), status=COALESCE($3,status), name=COALESCE($4,name),
         trial_ends_at = CASE WHEN $5::int IS NOT NULL THEN GREATEST(COALESCE(trial_ends_at, now()), now()) + make_interval(days => $5) ELSE trial_ends_at END WHERE id=$1`,
      [id, patch.planId ?? null, patch.status ?? null, patch.name ?? null, patch.extendTrialDays ?? null]);
    if (patch.planId) await db.exec(`INSERT INTO subscription_events (org_id, type, payload) VALUES ($1,'plan_changed_by_admin',$2)`, [id, JSON.stringify({ to: patch.planId, by: s.user.email })]);
    await audit(db, asActor(s), "admin.org_update", "organization", id, patch, { orgId: id });
  });
}

/** Suspension blocks sign-in to the tenant and public booking; ALL data is retained untouched. */
export async function suspendOrganization(s: SuperCtx, id: string, reason: string) {
  if (!reason.trim()) throw badRequest("A reason is required", "REASON_REQUIRED");
  await withSystem(async (db) => {
    const n = await db.exec(`UPDATE organizations SET status='suspended', suspended_at=now(), suspended_reason=$2 WHERE id=$1 AND status <> 'suspended'`, [id, reason.trim()]);
    if (!n) throw conflict("Organization not found or already suspended", "INVALID_STATE");
    await db.exec(`DELETE FROM sessions WHERE active_org_id=$1 AND user_id NOT IN (SELECT id FROM users WHERE is_super_admin)`, [id]);
    await audit(db, asActor(s), "admin.org_suspend", "organization", id, { reason }, { orgId: id });
  });
}
export async function reactivateOrganization(s: SuperCtx, id: string) {
  await withSystem(async (db) => {
    const n = await db.exec(`UPDATE organizations SET status='active', suspended_at=NULL, suspended_reason=NULL WHERE id=$1 AND status='suspended'`, [id]);
    if (!n) throw conflict("Organization is not suspended", "INVALID_STATE");
    await audit(db, asActor(s), "admin.org_reactivate", "organization", id, {}, { orgId: id });
  });
}

export async function platformOverview() {
  return withSystem(async (db) => {
    const t = await db.one<Record<string, number>>(
      `SELECT (SELECT count(*) FROM organizations)::int AS orgs, (SELECT count(*) FROM organizations WHERE status='trial')::int AS trials,
              (SELECT count(*) FROM organizations WHERE status='active')::int AS active, (SELECT count(*) FROM organizations WHERE status='suspended')::int AS suspended,
              (SELECT count(*) FROM organizations WHERE status='past_due')::int AS past_due,
              (SELECT count(*) FROM locations WHERE status='active')::int AS locations, (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM reservations WHERE created_at >= date_trunc('month', now()))::int AS reservations_month,
              (SELECT count(*) FROM notifications WHERE status='failed' AND created_at > now() - interval '24 hours')::int AS failed_notifications_24h,
              (SELECT COALESCE(sum(p.price_mad_monthly),0) FROM organizations o JOIN plans p ON p.id=o.plan_id WHERE o.status='active')::int AS mrr_mad`);
    const byPlan = await db.query(`SELECT p.id, p.name, count(o.id)::int AS orgs FROM plans p LEFT JOIN organizations o ON o.plan_id=p.id GROUP BY p.id, p.name, p.sort ORDER BY p.sort`);
    const dbPing = await db.one<{ now: Date }>(`SELECT now()`);
    return { totals: t, byPlan, health: await health(dbPing.now) };
  });
}

async function health(dbTime: Date) {
  const jobs = await jobStats();
  return {
    database: { ok: true, serverTime: dbTime },
    jobs: { ...jobs, ok: jobs.failed === 0 && (jobs.oldestQueuedAgeSec ?? 0) < 600 },
    integrations: { email: channelStatus("email"), sms: channelStatus("sms"), whatsapp: channelStatus("whatsapp"), payments: { provider: "none", state: "not_configured", message: "No billing provider adapter connected" } },
    environment: { nodeEnv: env.nodeEnv, simulatedNotifications: env.simulateNotifications },
  };
}

export async function platformAudit(before?: number) {
  return withSystem((db) => db.query(
    `SELECT a.id, a.action, a.actor_label, a.entity_type, a.entity_id, a.metadata, a.created_at, o.name AS org_name
       FROM audit_logs a LEFT JOIN organizations o ON o.id=a.org_id WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 150`, [before ?? null]));
}
