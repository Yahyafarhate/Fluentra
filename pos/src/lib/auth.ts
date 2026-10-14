import bcrypt from "bcryptjs";
import { withSystem, type Db } from "./db";
import { env } from "./env";
import { sha256, randomToken } from "./ids";
import { unauthorized, forbidden, AppError } from "./errors";
import { can, type Permission, type Role } from "./rbac";
import { rateLimit } from "./ratelimit";
import { audit } from "./audit";

export const SESSION_COOKIE = "cp_session";
const POS_SESSION_HOURS = 14;
const BACKOFFICE_SESSION_HOURS = 12;
const BACKOFFICE_IDLE_MIN = 480;

export const hashSecret = (s: string) => bcrypt.hash(s, env.bcryptCost);
export const verifySecret = (s: string, hash: string) => bcrypt.compare(s, hash);

export function validatePin(pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw new AppError(422, "INVALID_PIN", "PIN must be 4 to 8 digits");
  if (/^(\d)\1+$/.test(pin) || pin === "1234" || pin === "123456") throw new AppError(422, "WEAK_PIN", "PIN is too easy to guess");
}
export function validatePasswordStrength(pw: string) {
  if (pw.length < 10) throw new AppError(422, "WEAK_PASSWORD", "Password must be at least 10 characters");
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) throw new AppError(422, "WEAK_PASSWORD", "Password must contain letters and numbers");
}

export interface Ctx {
  employee: { id: string; name: string; email: string | null };
  orgId: string;
  role: Role;
  /** Outlet this POS session is bound to (null for back-office sessions) */
  outletId: string | null;
  /** null = all outlets in the organization */
  outletIds: string[] | null;
  kind: "pos" | "backoffice";
  org: { id: string; name: string; currency: string; status: string };
  sessionHash: string;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string | null, hours = POS_SESSION_HOURS) {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (env.isProd) attrs.push("Secure");
  attrs.push(token === null ? "Max-Age=0" : `Max-Age=${hours * 3600}`);
  return `${SESSION_COOKIE}=${token ?? ""}; ${attrs.join("; ")}`;
}

interface SessionRow {
  employeeId: string; name: string; email: string | null; role: Role; active: boolean; outletIdsAllowed: string[] | null;
  orgId: string; orgName: string; currency: string; orgStatus: string;
  outletId: string | null; kind: "pos" | "backoffice"; idleTimeoutMin: number; lastSeenAt: Date;
}

/** Resolve the tenant context from a session token. Enforces the idle lock (auto-logout). */
export async function getCtx(token: string | undefined): Promise<Ctx | null> {
  if (!token) return null;
  const hash = sha256(token);
  return withSystem(async (db) => {
    const s = await db.maybe<SessionRow>(
      `SELECT e.id AS employee_id, e.name, e.email, e.role, e.active, e.outlet_ids AS outlet_ids_allowed,
              o.id AS org_id, o.name AS org_name, o.currency, o.status AS org_status,
              s.outlet_id, s.kind, s.idle_timeout_min, s.last_seen_at
         FROM sessions s JOIN employees e ON e.id = s.employee_id JOIN organizations o ON o.id = s.org_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [hash]);
    if (!s || !s.active) return null;
    if (Date.now() - s.lastSeenAt.getTime() > s.idleTimeoutMin * 60_000) {
      await db.exec(`DELETE FROM sessions WHERE token_hash = $1`, [hash]);
      return null;
    }
    if (Date.now() - s.lastSeenAt.getTime() > 20_000) await db.exec(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [hash]);
    return {
      sessionHash: hash, kind: s.kind, orgId: s.orgId, role: s.role, outletId: s.outletId, outletIds: s.outletIdsAllowed,
      employee: { id: s.employeeId, name: s.name, email: s.email },
      org: { id: s.orgId, name: s.orgName, currency: s.currency, status: s.orgStatus },
    };
  });
}

export function assertPermission(ctx: Ctx, perm: Permission | Permission[]) {
  if (ctx.org.status !== "active") throw forbidden("This account is suspended. Please contact support.", "ORG_SUSPENDED");
  const list = Array.isArray(perm) ? perm : [perm];
  if (!list.every((p) => can(ctx.role, p))) throw forbidden();
}

/** POS sessions are bound to one outlet; back-office sessions may be limited to a list of outlets. */
export function assertOutletAccess(ctx: Ctx, outletId: string) {
  if (ctx.outletId && ctx.outletId !== outletId) throw forbidden("This terminal is bound to another outlet", "OUTLET_FORBIDDEN");
  if (ctx.outletIds && !ctx.outletIds.includes(outletId)) throw forbidden("No access to this outlet", "OUTLET_FORBIDDEN");
}

const MAX_FAILED = 5;
const LOCK_MIN = 10;
const DUMMY_HASH = "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali";

async function recordFailure(employeeId: string, ip: string, orgId: string, what: string) {
  await withSystem(async (db) => {
    await db.exec(
      `UPDATE employees SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + interval '${LOCK_MIN} minutes' ELSE locked_until END WHERE id = $1`, [employeeId, MAX_FAILED]);
    await audit(db, null, `auth.${what}_failed`, "employee", employeeId, {}, { orgId, ip });
  });
}

async function createSession(db: Db, e: { id: string; orgId: string }, kind: "pos" | "backoffice", outletId: string | null, idleMin: number, ip: string) {
  const token = randomToken(32);
  const hours = kind === "pos" ? POS_SESSION_HOURS : BACKOFFICE_SESSION_HOURS;
  await db.exec(`UPDATE employees SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [e.id]);
  await db.exec(
    `INSERT INTO sessions (token_hash, employee_id, org_id, outlet_id, kind, idle_timeout_min, expires_at, ip) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '${hours} hours',$7)`,
    [sha256(token), e.id, e.orgId, outletId, kind, idleMin, ip]);
  await audit(db, null, `auth.login_${kind}`, "employee", e.id, {}, { orgId: e.orgId, ip, outletId });
  return token;
}

/** Staff tiles shown on the POS login screen (names only). Requires the outlet terminal code. */
export async function staffForOutlet(code: string, ip: string) {
  await rateLimit(`staff:ip:${ip}`, 60, 600);
  return withSystem(async (db) => {
    const o = await db.maybe<{ id: string; name: string; orgId: string }>(`SELECT id, name, org_id FROM outlets WHERE code = $1 AND active`, [code.toUpperCase()]);
    if (!o) throw new AppError(404, "UNKNOWN_TERMINAL_CODE", "Unknown terminal code");
    const staff = await db.query<{ id: string; name: string; role: Role }>(
      `SELECT e.id, e.name, e.role FROM employees e JOIN organizations g ON g.id = e.org_id AND g.status = 'active'
        WHERE e.org_id = $1 AND e.active AND e.pin_hash IS NOT NULL AND (e.outlet_ids IS NULL OR $2 = ANY(e.outlet_ids)) ORDER BY e.name`, [o.orgId, o.id]);
    return { outlet: { id: o.id, name: o.name }, staff };
  });
}

export async function pinLogin(input: { outletCode: string; employeeId: string; pin: string }, meta: { ip: string }) {
  await rateLimit(`pin:ip:${meta.ip}`, 60, 600);
  await rateLimit(`pin:emp:${input.employeeId}`, 20, 600);
  const generic = new AppError(401, "INVALID_CREDENTIALS", "Wrong PIN");
  const found = await withSystem(async (db) => {
    const o = await db.maybe<{ id: string; orgId: string; idleLockMinutes: number }>(`SELECT id, org_id, idle_lock_minutes FROM outlets WHERE code = $1 AND active`, [input.outletCode.toUpperCase()]);
    if (!o) return null;
    const e = await db.maybe<{ id: string; orgId: string; pinHash: string | null; active: boolean; lockedUntil: Date | null; outletIds: string[] | null }>(
      `SELECT e.id, e.org_id, e.pin_hash, e.active, e.locked_until, e.outlet_ids FROM employees e JOIN organizations g ON g.id=e.org_id AND g.status='active'
        WHERE e.id = $1 AND e.org_id = $2`, [input.employeeId, o.orgId]);
    return e ? { o, e } : null;
  });
  if (!found || !found.e.active || !found.e.pinHash || (found.e.outletIds && !found.e.outletIds.includes(found.o.id))) {
    await bcrypt.compare(input.pin, DUMMY_HASH);
    throw generic;
  }
  if (found.e.lockedUntil && found.e.lockedUntil > new Date()) throw new AppError(423, "ACCOUNT_LOCKED", "Too many wrong PINs. Ask a manager or try again later.");
  if (!(await verifySecret(input.pin, found.e.pinHash))) {
    await recordFailure(found.e.id, meta.ip, found.e.orgId, "pin");
    throw generic;
  }
  const token = await withSystem((db) => createSession(db, found.e, "pos", found.o.id, found.o.idleLockMinutes, meta.ip));
  return { token, hours: POS_SESSION_HOURS };
}

export async function passwordLogin(email: string, password: string, meta: { ip: string }) {
  await rateLimit(`login:ip:${meta.ip}`, 30, 600);
  await rateLimit(`login:email:${email.toLowerCase()}`, 10, 600);
  const generic = new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  const e = await withSystem((db) => db.maybe<{ id: string; orgId: string; passwordHash: string | null; active: boolean; lockedUntil: Date | null; orgStatus: string }>(
    `SELECT e.id, e.org_id, e.password_hash, e.active, e.locked_until, g.status AS org_status FROM employees e JOIN organizations g ON g.id = e.org_id WHERE e.email = $1`, [email]));
  if (!e || !e.passwordHash) { await bcrypt.compare(password, DUMMY_HASH); throw generic; }
  if (e.lockedUntil && e.lockedUntil > new Date()) throw new AppError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
  if (!e.active || e.orgStatus !== "active" || !(await verifySecret(password, e.passwordHash))) {
    await recordFailure(e.id, meta.ip, e.orgId, "login");
    throw generic;
  }
  const token = await withSystem((db) => createSession(db, e, "backoffice", null, BACKOFFICE_IDLE_MIN, meta.ip));
  return { token, hours: BACKOFFICE_SESSION_HOURS };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await withSystem((db) => db.exec(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]));
}

export interface ApprovalInput { employeeId: string; pin: string }

/**
 * Four-eyes control for restricted actions. If the actor's own role holds `perm` the actor approves themselves
 * (still audited). Otherwise a different employee holding both `perm` and `approvals.grant` must enter their PIN.
 */
export async function resolveApprover(db: Db, ctx: Ctx, perm: Permission, approval: ApprovalInput | undefined): Promise<string> {
  if (can(ctx.role, perm)) return ctx.employee.id;
  if (!approval) throw new AppError(403, "APPROVAL_REQUIRED", "A supervisor approval is required for this action", { permission: perm });
  if (approval.employeeId === ctx.employee.id) throw forbidden("You cannot approve your own action", "SELF_APPROVAL");
  await rateLimit(`approval:${ctx.employee.id}`, 10, 600);
  const a = await db.maybe<{ id: string; role: Role; pinHash: string | null; active: boolean; lockedUntil: Date | null; outletIds: string[] | null }>(
    `SELECT id, role, pin_hash, active, locked_until, outlet_ids FROM employees WHERE id = $1 AND org_id = $2`, [approval.employeeId, ctx.orgId]);
  const bad = new AppError(403, "APPROVAL_DENIED", "Approval was not accepted");
  if (!a || !a.active || !a.pinHash || !can(a.role, perm) || !can(a.role, "approvals.grant")) { await bcrypt.compare(approval.pin, DUMMY_HASH); throw bad; }
  if (a.outletIds && ctx.outletId && !a.outletIds.includes(ctx.outletId)) throw bad;
  if (a.lockedUntil && a.lockedUntil > new Date()) throw new AppError(423, "ACCOUNT_LOCKED", "Approver is locked");
  if (!(await verifySecret(approval.pin, a.pinHash))) {
    // failure counters live in a separate system-scope transaction so they survive the caller's rollback
    await recordFailure(a.id, "approval", ctx.orgId, "approval");
    throw bad;
  }
  return a.id;
}
