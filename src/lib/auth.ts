import bcrypt from "bcryptjs";
import { withSystem, type Db } from "./db";
import { env } from "./env";
import { sha256, randomToken } from "./ids";
import { unauthorized, forbidden, AppError } from "./errors";
import { can, type Permission, type Role } from "./rbac";
import { rateLimit } from "./ratelimit";
import { audit } from "./audit";

export const SESSION_COOKIE = "fl_session";
const SESSION_DAYS = 14;

export const hashPassword = (pw: string) => bcrypt.hash(pw, env.bcryptCost);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function validatePasswordStrength(pw: string) {
  if (pw.length < 10) throw new AppError(422, "WEAK_PASSWORD", "Password must be at least 10 characters");
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) throw new AppError(422, "WEAK_PASSWORD", "Password must contain letters and numbers");
}

export interface Ctx {
  user: { id: string; email: string; name: string; locale: string; isSuperAdmin: boolean };
  orgId: string;
  role: Role;
  /** null = all locations in the organization */
  locationIds: string[] | null;
  org: { id: string; name: string; planId: string; status: string };
  sessionHash: string;
}
export interface SuperCtx { user: Ctx["user"]; sessionHash: string }

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string | null) {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (env.isProd) attrs.push("Secure");
  if (token === null) attrs.push("Max-Age=0");
  else attrs.push(`Max-Age=${SESSION_DAYS * 86400}`);
  return `${SESSION_COOKIE}=${token ?? ""}; ${attrs.join("; ")}`;
}

interface SessionRow {
  userId: string; email: string; name: string; locale: string; isSuperAdmin: boolean; disabled: boolean;
  activeOrgId: string | null; expiresAt: Date; lastSeenAt: Date;
}

async function loadSession(db: Db, hash: string): Promise<SessionRow | null> {
  return db.maybe<SessionRow>(
    `SELECT u.id AS user_id, u.email, u.name, u.locale, u.is_super_admin, u.disabled,
            s.active_org_id, s.expires_at, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash],
  );
}

/** Resolve the authenticated session (user only). */
export async function getSessionUser(token: string | undefined): Promise<SuperCtx | null> {
  if (!token) return null;
  const hash = sha256(token);
  return withSystem(async (db) => {
    const s = await loadSession(db, hash);
    if (!s || s.disabled) return null;
    if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) {
      await db.exec(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + interval '${SESSION_DAYS} days' WHERE token_hash = $1`, [hash]);
    }
    return { sessionHash: hash, user: { id: s.userId, email: s.email, name: s.name, locale: s.locale, isSuperAdmin: s.isSuperAdmin } };
  });
}

/** Resolve tenant context from a session token. Returns null when unauthenticated or without membership. */
export async function getCtx(token: string | undefined): Promise<Ctx | null> {
  if (!token) return null;
  const hash = sha256(token);
  return withSystem(async (db) => {
    const s = await loadSession(db, hash);
    if (!s || s.disabled) return null;
    if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) {
      await db.exec(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + interval '${SESSION_DAYS} days' WHERE token_hash = $1`, [hash]);
    }
    const memberships = await db.query<{ orgId: string; role: Role; locationIds: string[] | null; orgName: string; planId: string; orgStatus: string }>(
      `SELECT m.org_id, m.role, m.location_ids, o.name AS org_name, o.plan_id, o.status AS org_status
         FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY (m.org_id = $2) DESC, o.name`,
      [s.userId, s.activeOrgId],
    );
    const m = memberships[0];
    if (!m) return null;
    if (m.orgId !== s.activeOrgId) await db.exec(`UPDATE sessions SET active_org_id = $1 WHERE token_hash = $2`, [m.orgId, hash]);
    return {
      sessionHash: hash,
      user: { id: s.userId, email: s.email, name: s.name, locale: s.locale, isSuperAdmin: s.isSuperAdmin },
      orgId: m.orgId, role: m.role, locationIds: m.locationIds,
      org: { id: m.orgId, name: m.orgName, planId: m.planId, status: m.orgStatus },
    };
  });
}

export function assertPermission(ctx: Ctx, perm: Permission | Permission[]) {
  const list = Array.isArray(perm) ? perm : [perm];
  if (ctx.org.status === "suspended" || ctx.org.status === "cancelled") {
    throw forbidden("This account is suspended. Please contact support.", "ORG_SUSPENDED");
  }
  if (!list.every((p) => can(ctx.role, p))) throw forbidden();
}

export function assertLocationAccess(ctx: Ctx, locationId: string) {
  if (ctx.locationIds && !ctx.locationIds.includes(locationId)) throw forbidden("No access to this location", "LOCATION_FORBIDDEN");
}

export async function listMemberships(userId: string) {
  return withSystem((db) =>
    db.query<{ orgId: string; orgName: string; role: Role }>(
      `SELECT m.org_id, o.name AS org_name, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.name`, [userId]),
  );
}

export async function switchOrg(sessionHash: string, userId: string, orgId: string) {
  await withSystem(async (db) => {
    const m = await db.maybe(`SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active'`, [userId, orgId]);
    if (!m) throw forbidden();
    await db.exec(`UPDATE sessions SET active_org_id = $1 WHERE token_hash = $2`, [orgId, sessionHash]);
  });
}

const MAX_FAILED = 5;
const LOCK_MIN = 15;

export async function login(email: string, password: string, meta: { ip: string; userAgent?: string | null }) {
  await rateLimit(`login:ip:${meta.ip}`, 30, 600);
  await rateLimit(`login:email:${email.toLowerCase()}`, 10, 600);
  const generic = new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  const user = await withSystem((db) =>
    db.maybe<{ id: string; passwordHash: string; disabled: boolean; lockedUntil: Date | null; failedLogins: number; isSuperAdmin: boolean }>(
      `SELECT id, password_hash, disabled, locked_until, failed_logins, is_super_admin FROM users WHERE email = $1`, [email]),
  );
  if (!user) { await bcrypt.compare(password, "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali"); throw generic; }
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
  const ok = !user.disabled && (await verifyPassword(password, user.passwordHash));
  if (!ok) {
    await withSystem(async (db) => {
      await db.exec(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '${LOCK_MIN} minutes' ELSE locked_until END
         WHERE id = $1`, [user.id, MAX_FAILED]);
      await audit(db, null, "auth.login_failed", "user", user.id, {}, { ip: meta.ip });
    });
    throw generic;
  }
  const token = randomToken(32);
  await withSystem(async (db) => {
    await db.exec(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
    const firstOrg = await db.maybe<{ orgId: string }>(
      `SELECT m.org_id FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name LIMIT 1`, [user.id]);
    await db.exec(
      `INSERT INTO sessions (token_hash, user_id, active_org_id, expires_at, ip, user_agent) VALUES ($1,$2,$3, now() + interval '${SESSION_DAYS} days',$4,$5)`,
      [sha256(token), user.id, firstOrg?.orgId ?? null, meta.ip, meta.userAgent?.slice(0, 250) ?? null]);
    await audit(db, null, "auth.login", "user", user.id, {}, { ip: meta.ip, orgId: firstOrg?.orgId ?? null });
  });
  return { token, isSuperAdmin: user.isSuperAdmin };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await withSystem((db) => db.exec(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]));
}

/** Always resolves (no user enumeration). In development the link is logged; production sends via the email adapter. */
export async function requestPasswordReset(email: string, ip: string): Promise<{ devLink?: string }> {
  await rateLimit(`reset:ip:${ip}`, 10, 3600);
  await rateLimit(`reset:email:${email.toLowerCase()}`, 3, 3600);
  const token = randomToken(32);
  const user = await withSystem(async (db) => {
    const u = await db.maybe<{ id: string; name: string; locale: string }>(`SELECT id, name, locale FROM users WHERE email = $1 AND NOT disabled`, [email]);
    if (!u) return null;
    await db.exec(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sha256(token), u.id]);
    return u;
  });
  if (!user) return {};
  const link = `${env.appUrl}/reset-password?token=${token}`;
  const { sendSystemEmail } = await import("@/server/notifications/system-mail");
  await sendSystemEmail({ to: email, template: "password_reset", vars: { name: user.name, link }, locale: user.locale });
  return env.isProd ? {} : { devLink: link };
}

export async function resetPassword(token: string, newPassword: string) {
  validatePasswordStrength(newPassword);
  const hash = await hashPassword(newPassword);
  await withSystem(async (db) => {
    const row = await db.maybe<{ userId: string }>(
      `UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(token)]);
    if (!row) throw new AppError(400, "INVALID_TOKEN", "This reset link is invalid or has expired");
    await db.exec(`UPDATE users SET password_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2`, [hash, row.userId]);
    await db.exec(`DELETE FROM sessions WHERE user_id = $1`, [row.userId]);
    await audit(db, null, "auth.password_reset", "user", row.userId);
  });
}

export function requireSuper(ctx: SuperCtx | null): SuperCtx {
  if (!ctx) throw unauthorized();
  if (!ctx.user.isSuperAdmin) throw forbidden("Platform administrator access required", "SUPER_ADMIN_REQUIRED");
  return ctx;
}
