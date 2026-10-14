import { z } from "zod";
import type { Db } from "@/lib/db";
import { assertOutletAccess, hashSecret, validatePasswordStrength, validatePin, type Ctx } from "@/lib/auth";
import { assignableRoles, ROLES, type Role } from "@/lib/rbac";
import { conflict, forbidden, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";

export const employeeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  email: z.email().max(200).transform((s) => s.toLowerCase()).nullable().optional(),
  password: z.string().min(10).max(200).nullable().optional(),
  pin: z.string().regex(/^\d{4,8}$/).nullable().optional(),
  outletIds: z.array(z.uuid()).nullable().optional(),
});

export const listEmployees = (db: Db) => db.query<{ id: string; name: string; role: Role; email: string | null; outletIds: string[] | null; active: boolean; hasPin: boolean; hasPassword: boolean; lockedUntil: Date | null }>(
  `SELECT id, name, role, email, outlet_ids, active, pin_hash IS NOT NULL AS has_pin, password_hash IS NOT NULL AS has_password, locked_until FROM employees ORDER BY name`);

function assertCanGrant(ctx: Ctx, role: Role) {
  if (!assignableRoles(ctx.role).includes(role)) throw forbidden("You cannot assign this role", "ROLE_NOT_ASSIGNABLE");
}

export async function createEmployee(db: Db, ctx: Ctx, input: z.infer<typeof employeeSchema>) {
  assertCanGrant(ctx, input.role);
  if (input.pin) validatePin(input.pin);
  if (input.password) { validatePasswordStrength(input.password); if (!input.email) throw conflict("An email is required for back-office access", "EMAIL_REQUIRED"); }
  if (input.outletIds) for (const o of input.outletIds) assertOutletAccess(ctx, o);
  if (input.email && await db.maybe(`SELECT 1 FROM employees WHERE email = $1`, [input.email])) throw conflict("This email is already used", "EMAIL_TAKEN");
  const e = await db.one<{ id: string }>(
    `INSERT INTO employees (org_id, name, email, password_hash, pin_hash, role, outlet_ids) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.orgId, input.name, input.email ?? null, input.password ? await hashSecret(input.password) : null, input.pin ? await hashSecret(input.pin) : null, input.role, input.outletIds ?? null]);
  await audit(db, ctx, "employee.create", "employee", e.id, { name: input.name, role: input.role });
  return e;
}

export async function updateEmployee(db: Db, ctx: Ctx, id: string, input: Partial<z.infer<typeof employeeSchema>> & { active?: boolean; unlock?: boolean }) {
  const cur = await db.maybe<{ role: Role }>(`SELECT role FROM employees WHERE id = $1`, [id]);
  if (!cur) throw notFound("Employee");
  assertCanGrant(ctx, cur.role); // cannot edit someone above your level
  if (input.role) assertCanGrant(ctx, input.role);
  if (id === ctx.employee.id && (input.active === false || (input.role && input.role !== cur.role))) throw forbidden("You cannot change your own role or deactivate yourself", "SELF_CHANGE");
  if (input.pin) validatePin(input.pin);
  if (input.password) validatePasswordStrength(input.password);
  if (input.email && await db.maybe(`SELECT 1 FROM employees WHERE email = $1 AND id <> $2`, [input.email, id])) throw conflict("This email is already used", "EMAIL_TAKEN");
  await db.exec(
    `UPDATE employees SET name = COALESCE($2,name), role = COALESCE($3,role), email = COALESCE($4,email), password_hash = COALESCE($5,password_hash), pin_hash = COALESCE($6,pin_hash),
       active = COALESCE($7,active), outlet_ids = CASE WHEN $8::boolean THEN $9::uuid[] ELSE outlet_ids END,
       failed_attempts = CASE WHEN $10::boolean THEN 0 ELSE failed_attempts END, locked_until = CASE WHEN $10::boolean THEN NULL ELSE locked_until END WHERE id = $1`,
    [id, input.name ?? null, input.role ?? null, input.email ?? null, input.password ? await hashSecret(input.password) : null, input.pin ? await hashSecret(input.pin) : null,
     input.active ?? null, input.outletIds !== undefined, input.outletIds ?? null, !!input.unlock]);
  if (input.active === false) await db.exec(`DELETE FROM sessions WHERE employee_id = $1`, [id]);
  await audit(db, ctx, "employee.update", "employee", id, { ...input, password: input.password ? "[set]" : undefined, pin: input.pin ? "[set]" : undefined });
}
