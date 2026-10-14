import { z } from "zod";
import { withSystem, type Db } from "@/lib/db";
import { hashSecret, validatePasswordStrength, validatePin } from "@/lib/auth";
import { shortCode } from "@/lib/ids";
import { audit } from "@/lib/audit";
import { conflict } from "@/lib/errors";

export const signupSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  outletName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email: z.email().max(200).transform((s) => s.toLowerCase()),
  password: z.string().min(10).max(200),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).default("MAD"),
  timezone: z.string().min(3).max(60).default("Africa/Casablanca"),
  locale: z.enum(["fr", "en", "ar"]).default("fr"),
});
export type SignupInput = z.infer<typeof signupSchema>;

const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "org";

async function uniqueSlug(db: Db, base: string) {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    if (!(await db.maybe(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]))) return slug;
  }
  return `${root}-${shortCode(4).toLowerCase()}`;
}

async function uniqueTerminalCode(db: Db) {
  for (let i = 0; i < 20; i++) {
    const code = shortCode(6);
    if (!(await db.maybe(`SELECT 1 FROM outlets WHERE code = $1`, [code]))) return code;
  }
  throw new Error("could not allocate a terminal code");
}

/** Adds an outlet with its default stations and a first dining room. */
const DEFAULT_NAMES: Record<string, { kitchen: string; bar: string; pastry: string; room: string }> = {
  fr: { kitchen: "Cuisine", bar: "Bar", pastry: "Pâtisserie", room: "Salle principale" },
  en: { kitchen: "Kitchen", bar: "Bar", pastry: "Pastry", room: "Main room" },
  ar: { kitchen: "Kitchen", bar: "Bar", pastry: "Pastry", room: "Main room" },
};

export async function createOutletDefaults(db: Db, orgId: string, name: string, timezone = "Africa/Casablanca") {
  const code = await uniqueTerminalCode(db);
  const org = await db.maybe<{ defaultLocale: string }>(`SELECT default_locale FROM organizations WHERE id = $1`, [orgId]);
  const n = DEFAULT_NAMES[org?.defaultLocale ?? "en"] ?? DEFAULT_NAMES.en;
  const o = await db.one<{ id: string }>(`INSERT INTO outlets (org_id, name, code, timezone) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, name, code, timezone]);
  await db.exec(`INSERT INTO stations (org_id, outlet_id, name, kind, target_seconds) VALUES ($1,$2,$3,'kitchen',900), ($1,$2,$4,'bar',300), ($1,$2,$5,'pastry',600)`, [orgId, o.id, n.kitchen, n.bar, n.pastry]);
  const room = await db.one<{ id: string }>(`INSERT INTO dining_rooms (org_id, outlet_id, name) VALUES ($1,$2,$3) RETURNING id`, [orgId, o.id, n.room]);
  return { id: o.id, code, roomId: room.id };
}

/** Creates a tenant: organization, owner, default tax rates, first outlet. */
export async function createOrganization(input: SignupInput) {
  validatePasswordStrength(input.password);
  if (input.pin) validatePin(input.pin);
  const passwordHash = await hashSecret(input.password);
  const pinHash = input.pin ? await hashSecret(input.pin) : null;
  return withSystem(async (db) => {
    if (await db.maybe(`SELECT 1 FROM employees WHERE email = $1`, [input.email])) throw conflict("An account with this email already exists", "EMAIL_TAKEN");
    const slug = await uniqueSlug(db, input.organizationName);
    const org = await db.one<{ id: string }>(`INSERT INTO organizations (name, slug, currency, default_locale) VALUES ($1,$2,$3,$4) RETURNING id`, [input.organizationName, slug, input.currency, input.locale]);
    const owner = await db.one<{ id: string }>(
      `INSERT INTO employees (org_id, name, email, password_hash, pin_hash, role) VALUES ($1,$2,$3,$4,$5,'owner') RETURNING id`,
      [org.id, input.ownerName, input.email, passwordHash, pinHash]);
    // Moroccan VAT rates for restaurants are a starting point only — to be validated by the accountant.
    await db.exec(`INSERT INTO tax_rates (org_id, name, rate_bps) VALUES ($1,'TVA 10%',1000), ($1,'TVA 20%',2000), ($1,'TVA 0%',0)`, [org.id]);
    const outlet = await createOutletDefaults(db, org.id, input.outletName, input.timezone);
    await audit(db, null, "org.created", "organization", org.id, { outletId: outlet.id }, { orgId: org.id });
    return { orgId: org.id, slug, ownerId: owner.id, outletId: outlet.id, terminalCode: outlet.code };
  });
}
