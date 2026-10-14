import { z } from "zod";
import { Router } from "@/server/http/router";
import { json, publicRoute, authed } from "@/lib/api";
import { logout, passwordLogin, pinLogin, parseCookies, sessionCookie, staffForOutlet, SESSION_COOKIE, hashSecret, verifySecret, validatePin } from "@/lib/auth";
import { withOrg } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { createOrganization, signupSchema } from "@/server/setup/service";
import { can, PERMISSIONS } from "@/lib/rbac";

export const authRouter = new Router("/api/auth");

const signupEnabled = () => process.env.POS_ALLOW_SIGNUP === "true" || (process.env.POS_ALLOW_SIGNUP !== "false" && process.env.NODE_ENV !== "production");

authRouter.add("POST", "/signup", "public", "Create an organization with its first outlet and owner", publicRoute({ rate: { key: "signup", limit: 5, windowSec: 3600 } }, async (a) => {
  if (!signupEnabled()) throw new AppError(403, "SIGNUP_DISABLED", "Self-service signup is disabled");
  const r = await createOrganization(await a.body(signupSchema));
  return json(r, 201);
}));

authRouter.add("POST", "/login", "public", "Back-office login (email + password)", publicRoute({ rate: { key: "login", limit: 60, windowSec: 600 } }, async (a) => {
  const b = await a.body(z.object({ email: z.email().transform((s) => s.toLowerCase()), password: z.string().min(1).max(200) }));
  const { token, hours } = await passwordLogin(b.email, b.password, { ip: a.ip });
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, hours) });
}));

authRouter.add("GET", "/staff", "public", "Staff tiles for a terminal code (POS login screen)", publicRoute({ rate: { key: "staff", limit: 120, windowSec: 600 } }, async (a) => {
  const { code } = a.query(z.object({ code: z.string().trim().min(4).max(10) }));
  return staffForOutlet(code, a.ip);
}));

authRouter.add("POST", "/pin-login", "public", "POS login (terminal code + employee + PIN)", publicRoute({ rate: { key: "pin", limit: 120, windowSec: 600 } }, async (a) => {
  const b = await a.body(z.object({ outletCode: z.string().trim().min(4).max(10), employeeId: z.uuid(), pin: z.string().regex(/^\d{4,8}$/) }));
  const { token, hours } = await pinLogin(b, { ip: a.ip });
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, hours) });
}));

authRouter.add("POST", "/logout", "public", "End the session (also used to lock the terminal)", publicRoute({ rate: { key: "logout", limit: 120, windowSec: 600 } }, async (a) => {
  await logout(parseCookies(a.req.headers.get("cookie"))[SESSION_COOKIE]);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(null) });
}));

authRouter.add("GET", "/me", "any signed-in employee", "Current employee, organization, outlet binding and permissions", authed(null, async ({ ctx }) => ({
  employee: ctx.employee, role: ctx.role, org: ctx.org, kind: ctx.kind, outletId: ctx.outletId, outletIds: ctx.outletIds,
  permissions: PERMISSIONS.filter((p) => can(ctx.role, p)),
  testPayments: (await import("@/server/payments/providers")).cardProvider()?.isTest ?? false,
  cardPayments: !!(await import("@/server/payments/providers")).cardProvider(),
})));

authRouter.add("POST", "/change-pin", "any signed-in employee", "Change your own PIN", authed(null, async (a) => {
  const b = await a.body(z.object({ currentPin: z.string().regex(/^\d{4,8}$/), newPin: z.string().regex(/^\d{4,8}$/) }));
  validatePin(b.newPin);
  await withOrg(a.ctx.orgId, async (db) => {
    const e = await db.one<{ pinHash: string | null }>(`SELECT pin_hash FROM employees WHERE id = $1`, [a.ctx.employee.id]);
    if (!e.pinHash || !(await verifySecret(b.currentPin, e.pinHash))) throw new AppError(403, "INVALID_CREDENTIALS", "Current PIN is wrong");
    await db.exec(`UPDATE employees SET pin_hash = $2 WHERE id = $1`, [a.ctx.employee.id, await hashSecret(b.newPin)]);
    await audit(db, a.ctx, "employee.change_pin", "employee", a.ctx.employee.id);
  });
  return { ok: true };
}));
