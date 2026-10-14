import { z } from "zod";
import { Router } from "../http/router";
import { json, publicRoute, sessionOnly } from "@/lib/api";
import { login, logout, requestPasswordReset, resetPassword, sessionCookie, getCtx, parseCookies, SESSION_COOKIE, switchOrg, listMemberships, getSessionUser } from "@/lib/auth";
import { signup, signupSchema } from "../tenants/signup";
import { acceptInvitation, acceptSchema, getInvitation } from "../tenants/team";
import { withOrg } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { getPlanInfo } from "../billing/limits";
import { unauthorized } from "@/lib/errors";

export const authRouter = new Router("/api/auth");
const cookieOf = (req: Request) => parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
const withCookie = (body: unknown, token: string | null, status = 200) => json(body, status, { "Set-Cookie": sessionCookie(token) });

authRouter.add("POST", "/login", "public", "Log in with email + password", publicRoute({ rate: { key: "auth-login", limit: 40, windowSec: 600 } }, async (a) => {
  const { email, password } = await a.body(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }));
  const r = await login(email, password, { ip: a.ip, userAgent: a.req.headers.get("user-agent") });
  return withCookie({ ok: true, isSuperAdmin: r.isSuperAdmin }, r.token);
}));

authRouter.add("POST", "/logout", "session", "End the current session", publicRoute({ rate: { key: "auth-logout", limit: 100, windowSec: 600 } }, async (a) => {
  await logout(cookieOf(a.req));
  return withCookie({ ok: true }, null);
}));

authRouter.add("POST", "/signup", "public", "Create an organization, owner account and first restaurant (14-day trial)", publicRoute({ rate: { key: "auth-signup", limit: 20, windowSec: 3600 } }, async (a) => {
  const input = await a.body(signupSchema);
  const r = await signup(input, a.ip);
  return withCookie({ ok: true, organizationId: r.orgId, locationId: r.locationId, slug: r.slug }, r.token, 201);
}));

authRouter.add("POST", "/forgot-password", "public", "Request a password reset email (always returns ok)", publicRoute({ rate: { key: "auth-forgot", limit: 20, windowSec: 3600 } }, async (a) => {
  const { email } = await a.body(z.object({ email: z.string().trim().toLowerCase().email() }));
  const r = await requestPasswordReset(email, a.ip);
  return { ok: true, ...(r.devLink ? { devLink: r.devLink, devNote: "Development only: the reset link is returned because no email provider is configured." } : {}) };
}));

authRouter.add("POST", "/reset-password", "public", "Set a new password using a reset token", publicRoute({ rate: { key: "auth-reset", limit: 20, windowSec: 3600 } }, async (a) => {
  const { token, password } = await a.body(z.object({ token: z.string().min(10).max(200), password: z.string().min(10).max(200) }));
  await resetPassword(token, password);
  return { ok: true };
}));

authRouter.add("GET", "/invitation", "public", "Inspect an invitation token", publicRoute({ rate: { key: "auth-inv", limit: 60, windowSec: 600 }, csrf: false }, async (a) => {
  const token = a.url.searchParams.get("token") ?? "";
  const inv = await getInvitation(token);
  return { email: inv.email, role: inv.role, organization: inv.orgName, userExists: inv.userExists };
}));

authRouter.add("POST", "/accept-invitation", "public", "Accept an invitation (creates the account when new)", publicRoute({ rate: { key: "auth-accept", limit: 20, windowSec: 3600 } }, async (a) => {
  const input = await a.body(acceptSchema);
  const s = await getSessionUser(cookieOf(a.req));
  const r = await acceptInvitation(input, s?.user.id ?? null, a.ip);
  return withCookie({ ok: true }, r.token);
}));

authRouter.add("GET", "/me", "session", "Current user, organization, role, permissions and locations", sessionOnly(async (a) => {
  const ctx = await getCtx(cookieOf(a.req));
  const memberships = await listMemberships(a.ctx.user.id);
  if (!ctx) return { user: a.ctx.user, organization: null, memberships };
  const data = await withOrg(ctx.orgId, async (db) => ({
    locations: await db.query(`SELECT id, name, slug, timezone, currency, default_locale FROM locations WHERE org_id=$1 AND status='active' AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY name`, [ctx.orgId, ctx.locationIds]),
    plan: await getPlanInfo(db, ctx.orgId),
  }));
  return {
    user: a.ctx.user,
    organization: { id: ctx.orgId, name: ctx.org.name, status: ctx.org.status, planId: ctx.org.planId },
    role: ctx.role, permissions: [...ROLE_PERMISSIONS[ctx.role]], locationIds: ctx.locationIds,
    features: data.plan.features, locations: data.locations, memberships,
    trialEndsAt: data.plan.trialEndsAt,
  };
}));

authRouter.add("POST", "/switch-org", "session", "Switch the active organization", sessionOnly(async (a) => {
  const { orgId } = await a.body(z.object({ orgId: z.string().uuid() }));
  await switchOrg(a.ctx.sessionHash, a.ctx.user.id, orgId);
  return { ok: true };
}));

export { unauthorized };
