import { z } from "zod";
import { withSystem, type Db } from "@/lib/db";
import { assertPermission, hashPassword, validatePasswordStrength, type Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { randomToken, sha256 } from "@/lib/ids";
import { env } from "@/lib/env";
import { ROLES, assignableRoles, ROLE_PERMISSIONS, type Role } from "@/lib/rbac";
import { assertWithinPlan } from "../billing/limits";
import { sendSystemEmail } from "../notifications/system-mail";

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(ROLES),
  locationIds: z.array(z.string().uuid()).max(100).nullable().optional(),
});

async function assertLocationsInOrg(db: Db, orgId: string, ids?: string[] | null) {
  if (!ids?.length) return;
  const n = await db.one<{ n: number }>(`SELECT count(*)::int n FROM locations WHERE org_id=$1 AND id = ANY($2)`, [orgId, ids]);
  if (n.n !== new Set(ids).size) throw badRequest("One or more locations do not belong to this organization", "INVALID_LOCATIONS");
}

export async function listTeam(db: Db, ctx: Ctx) {
  const members = await db.query(
    `SELECT m.id, m.role, m.status, m.location_ids, m.created_at, u.id AS user_id, u.name, u.email, u.last_login_at
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.created_at`, [ctx.orgId]);
  const invitations = await db.query(`SELECT id, email, role, location_ids, expires_at, created_at FROM invitations WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [ctx.orgId]);
  return { members, invitations, assignableRoles: assignableRoles(ctx.role), permissions: Object.fromEntries(ROLES.map((r) => [r, [...ROLE_PERMISSIONS[r]]])) };
}

export async function inviteMember(db: Db, ctx: Ctx, input: z.infer<typeof inviteSchema>) {
  if (!assignableRoles(ctx.role).includes(input.role)) throw forbidden("You cannot grant that role", "ROLE_NOT_ASSIGNABLE");
  await assertLocationsInOrg(db, ctx.orgId, input.locationIds);
  await assertWithinPlan(db, ctx.orgId, "users");
  const exists = await db.maybe(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND u.email=$2`, [ctx.orgId, input.email]);
  if (exists) throw conflict("This person is already a member", "ALREADY_MEMBER");
  await db.exec(`DELETE FROM invitations WHERE org_id=$1 AND email=$2 AND accepted_at IS NULL`, [ctx.orgId, input.email]);
  const token = randomToken(32);
  const inv = await db.one<{ id: string }>(
    `INSERT INTO invitations (org_id, email, role, location_ids, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days') RETURNING id`,
    [ctx.orgId, input.email, input.role, input.locationIds?.length ? input.locationIds : null, sha256(token), ctx.user.id]);
  await audit(db, ctx, "team.invite", "invitation", inv.id, { email: input.email, role: input.role });
  const link = `${env.appUrl}/accept-invite?token=${token}`;
  db.afterCommit(async () => { await sendSystemEmail({ to: input.email, template: "invitation", vars: { org: ctx.org.name, inviter: ctx.user.name, role: input.role.replace("_", " "), link }, locale: ctx.user.locale }); });
  return { id: inv.id, devLink: env.isProd ? undefined : link };
}

export async function revokeInvitation(db: Db, ctx: Ctx, id: string) {
  const n = await db.exec(`DELETE FROM invitations WHERE id=$1 AND org_id=$2 AND accepted_at IS NULL`, [id, ctx.orgId]);
  if (!n) throw notFound("Invitation");
  await audit(db, ctx, "team.invite_revoked", "invitation", id);
}

export async function getInvitation(token: string) {
  return withSystem(async (db) => {
    const inv = await db.maybe<{ id: string; email: string; role: Role; orgName: string; userExists: boolean }>(
      `SELECT i.id, i.email, i.role, o.name AS org_name, EXISTS(SELECT 1 FROM users u WHERE u.email=i.email) AS user_exists
         FROM invitations i JOIN organizations o ON o.id=i.org_id WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at > now()`, [sha256(token)]);
    if (!inv) throw notFound("Invitation");
    return inv;
  });
}

export const acceptSchema = z.object({ token: z.string().min(10), name: z.string().trim().min(2).max(100).optional(), password: z.string().min(10).max(200).optional() });
export async function acceptInvitation(input: z.infer<typeof acceptSchema>, sessionUserId: string | null, ip: string) {
  const sessionToken = randomToken(32);
  await withSystem(async (db) => {
    const inv = await db.maybe<{ id: string; orgId: string; email: string; role: Role; locationIds: string[] | null }>(
      `SELECT id, org_id, email, role, location_ids FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(input.token)]);
    if (!inv) throw notFound("Invitation");
    let user = await db.maybe<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [inv.email]);
    if (user) {
      if (sessionUserId !== user.id) throw forbidden("Log in with the invited email address first, then open the invitation link again", "LOGIN_REQUIRED");
    } else {
      if (!input.password || !input.name) throw badRequest("Name and password are required to create your account", "ACCOUNT_DETAILS_REQUIRED");
      validatePasswordStrength(input.password);
      user = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`, [inv.email, await hashPassword(input.password), input.name]);
    }
    await db.exec(`INSERT INTO memberships (org_id, user_id, role, location_ids) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, user_id) DO UPDATE SET role=EXCLUDED.role, location_ids=EXCLUDED.location_ids, status='active'`, [inv.orgId, user.id, inv.role, inv.locationIds]);
    await db.exec(`UPDATE invitations SET accepted_at=now() WHERE id=$1`, [inv.id]);
    await db.exec(`INSERT INTO sessions (token_hash, user_id, active_org_id, expires_at, ip) VALUES ($1,$2,$3, now() + interval '14 days', $4)`, [sha256(sessionToken), user.id, inv.orgId, ip]);
    await audit(db, null, "team.invite_accepted", "membership", user.id, { role: inv.role }, { orgId: inv.orgId });
  });
  return { token: sessionToken };
}

export const memberPatchSchema = z.object({ role: z.enum(ROLES).optional(), locationIds: z.array(z.string().uuid()).nullable().optional(), status: z.enum(["active", "disabled"]).optional() });

export async function updateMember(db: Db, ctx: Ctx, membershipId: string, patch: z.infer<typeof memberPatchSchema>) {
  const m = await db.maybe<{ id: string; userId: string; role: Role; status: string }>(`SELECT id, user_id, role, status FROM memberships WHERE id=$1 AND org_id=$2 FOR UPDATE`, [membershipId, ctx.orgId]);
  if (!m) throw notFound("Member");
  const allowed = assignableRoles(ctx.role);
  if (!allowed.includes(m.role)) throw forbidden("You cannot modify a member with this role", "ROLE_NOT_ASSIGNABLE");
  if (patch.role && !allowed.includes(patch.role)) throw forbidden("You cannot grant that role", "ROLE_NOT_ASSIGNABLE");
  if (m.userId === ctx.user.id && (patch.role || patch.status === "disabled")) throw forbidden("You cannot change your own role or disable yourself", "SELF_MODIFICATION");
  const losesOwner = m.role === "owner" && ((patch.role && patch.role !== "owner") || patch.status === "disabled");
  if (losesOwner) {
    const owners = await db.one<{ n: number }>(`SELECT count(*)::int n FROM memberships WHERE org_id=$1 AND role='owner' AND status='active'`, [ctx.orgId]);
    if (owners.n <= 1) throw conflict("An organization needs at least one active owner", "LAST_OWNER");
  }
  if (patch.locationIds !== undefined) await assertLocationsInOrg(db, ctx.orgId, patch.locationIds);
  await db.exec(
    `UPDATE memberships SET role=COALESCE($3,role), status=COALESCE($4,status), location_ids = CASE WHEN $5::boolean THEN $6::uuid[] ELSE location_ids END WHERE id=$1 AND org_id=$2`,
    [membershipId, ctx.orgId, patch.role ?? null, patch.status ?? null, patch.locationIds !== undefined, patch.locationIds?.length ? patch.locationIds : null]);
  if (patch.status === "disabled" || patch.role) await withSystem((s) => s.exec(`DELETE FROM sessions WHERE user_id=$1 AND active_org_id=$2`, [m.userId, ctx.orgId]));
  await audit(db, ctx, "team.update", "membership", membershipId, { from: m.role, patch });
}

export async function removeMember(db: Db, ctx: Ctx, membershipId: string) {
  const m = await db.maybe<{ userId: string; role: Role }>(`SELECT user_id, role FROM memberships WHERE id=$1 AND org_id=$2 FOR UPDATE`, [membershipId, ctx.orgId]);
  if (!m) throw notFound("Member");
  if (!assignableRoles(ctx.role).includes(m.role)) throw forbidden("You cannot remove a member with this role", "ROLE_NOT_ASSIGNABLE");
  if (m.userId === ctx.user.id) throw forbidden("You cannot remove yourself", "SELF_MODIFICATION");
  if (m.role === "owner") {
    const owners = await db.one<{ n: number }>(`SELECT count(*)::int n FROM memberships WHERE org_id=$1 AND role='owner' AND status='active'`, [ctx.orgId]);
    if (owners.n <= 1) throw conflict("An organization needs at least one active owner", "LAST_OWNER");
  }
  await db.exec(`DELETE FROM memberships WHERE id=$1 AND org_id=$2`, [membershipId, ctx.orgId]);
  await audit(db, ctx, "team.remove", "membership", membershipId, { role: m.role });
}

export { assertPermission };
