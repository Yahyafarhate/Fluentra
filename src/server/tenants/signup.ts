import { z } from "zod";
import { withSystem, type Db } from "@/lib/db";
import { hashPassword, validatePasswordStrength } from "@/lib/auth";
import { AppError, conflict } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/ids";
import { rateLimit } from "@/lib/ratelimit";
import { seedDefaultAutomations } from "../automation/service";
import { isValidZone } from "@/lib/time";

export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "restaurant";

export async function uniqueSlug(db: Db, table: "locations" | "organizations", base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 30; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    if (!(await db.maybe(`SELECT 1 FROM ${table} WHERE slug = $1`, [slug]))) return slug;
  }
  return `${root}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

/** Creates the default locations setup (services, floor, section). */
export async function createLocationWithDefaults(db: Db, orgId: string, input: { name: string; city?: string | null; timezone?: string; locale?: string; address?: string | null; phone?: string | null }) {
  const tz = input.timezone && isValidZone(input.timezone) ? input.timezone : "Africa/Casablanca";
  const slug = await uniqueSlug(db, "locations", input.name);
  const loc = await db.one<{ id: string }>(
    `INSERT INTO locations (org_id, name, slug, city, timezone, default_locale, address, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, input.name, slug, input.city ?? null, tz, input.locale ?? "fr", input.address ?? null, input.phone ?? null]);
  await db.exec(`INSERT INTO services (org_id, location_id, name, days, start_time, last_seating, sort) VALUES
      ($1,$2,'Lunch','{1,2,3,4,5,6,7}','12:00','14:30',1), ($1,$2,'Dinner','{1,2,3,4,5,6,7}','19:00','22:30',2)`, [orgId, loc.id]);
  const floor = await db.one<{ id: string }>(`INSERT INTO floors (org_id, location_id, name) VALUES ($1,$2,'Main floor') RETURNING id`, [orgId, loc.id]);
  await db.exec(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,'Dining room','indoor')`, [orgId, loc.id]);
  return { id: loc.id, slug, floorId: floor.id };
}

export const signupSchema = z.object({
  organizationName: z.string().trim().min(2).max(100),
  restaurantName: z.string().trim().min(2).max(100),
  city: z.string().trim().max(80).optional(),
  ownerName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10).max(200),
  locale: z.enum(["fr", "en", "ar"]).default("fr"),
});

export async function signup(input: z.infer<typeof signupSchema>, ip: string) {
  await rateLimit(`signup:${ip}`, 10, 3600);
  validatePasswordStrength(input.password);
  const hash = await hashPassword(input.password);
  const token = randomToken(32);
  const result = await withSystem(async (db) => {
    if (await db.maybe(`SELECT 1 FROM users WHERE email=$1`, [input.email])) throw conflict("An account with this email already exists. Log in instead.", "EMAIL_TAKEN");
    const slug = await uniqueSlug(db, "organizations", input.organizationName);
    const org = await db.one<{ id: string }>(
      `INSERT INTO organizations (name, slug, plan_id, status, trial_ends_at, locale) VALUES ($1,$2,'pro','trial', now() + interval '14 days', $3) RETURNING id`, [input.organizationName, slug, input.locale]);
    const user = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, name, locale) VALUES ($1,$2,$3,$4) RETURNING id`, [input.email, hash, input.ownerName, input.locale]);
    await db.exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, user.id]);
    const loc = await createLocationWithDefaults(db, org.id, { name: input.restaurantName, city: input.city, locale: input.locale });
    await seedDefaultAutomations(db, org.id);
    await db.exec(`INSERT INTO sessions (token_hash, user_id, active_org_id, expires_at, ip) VALUES ($1,$2,$3, now() + interval '14 days', $4)`, [sha256(token), user.id, org.id, ip]);
    await audit(db, { orgId: org.id, user: { id: user.id, email: input.email } as never }, "org.signup", "organization", org.id, { locationId: loc.id });
    return { orgId: org.id, locationId: loc.id, slug: loc.slug };
  });
  return { token, ...result };
}

export { AppError };
