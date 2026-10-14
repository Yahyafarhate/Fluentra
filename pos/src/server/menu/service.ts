import { z } from "zod";
import type { Db } from "@/lib/db";
import { assertOutletAccess, type Ctx } from "@/lib/auth";
import { notFound, badRequest } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { loadOutlet } from "@/server/outlets/service";

/* ───────── tax rates, categories, discounts ───────── */
export const taxRateSchema = z.object({ name: z.string().trim().min(1).max(60), rateBps: z.number().int().min(0).max(10000) });
export const listTaxRates = (db: Db) => db.query<{ id: string; name: string; rateBps: number; active: boolean }>(`SELECT id, name, rate_bps, active FROM tax_rates ORDER BY rate_bps`);
export async function createTaxRate(db: Db, ctx: Ctx, input: z.infer<typeof taxRateSchema>) {
  const r = await db.one<{ id: string }>(`INSERT INTO tax_rates (org_id, name, rate_bps) VALUES ($1,$2,$3) RETURNING id`, [ctx.orgId, input.name, input.rateBps]);
  await audit(db, ctx, "tax_rate.create", "tax_rate", r.id, input);
  return r;
}

export const categorySchema = z.object({ name: z.string().trim().min(1).max(80), parentId: z.uuid().nullable().optional(), sort: z.number().int().min(0).max(1000).default(0), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() });
export async function createCategory(db: Db, ctx: Ctx, input: z.infer<typeof categorySchema>) {
  const c = await db.one<{ id: string }>(`INSERT INTO categories (org_id, parent_id, name, sort, color) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.orgId, input.parentId ?? null, input.name, input.sort, input.color ?? null]);
  await audit(db, ctx, "category.create", "category", c.id, { name: input.name });
  return c;
}
export async function updateCategory(db: Db, ctx: Ctx, id: string, input: Partial<z.infer<typeof categorySchema>> & { active?: boolean }) {
  const n = await db.exec(`UPDATE categories SET name = COALESCE($2,name), sort = COALESCE($3,sort), color = COALESCE($4,color), active = COALESCE($5,active) WHERE id = $1`, [id, input.name ?? null, input.sort ?? null, input.color ?? null, input.active ?? null]);
  if (!n) throw notFound("Category");
  await audit(db, ctx, "category.update", "category", id, input);
}

export const discountSchema = z.object({
  name: z.string().trim().min(1).max(60), kind: z.enum(["percent", "amount"]),
  value: z.number().int().min(1).max(10_000_000), approvalThresholdBps: z.number().int().min(0).max(10000).default(1000),
}).refine((d) => d.kind !== "percent" || d.value <= 10000, { message: "A percentage cannot exceed 100%", path: ["value"] });
export const listDiscounts = (db: Db) => db.query<{ id: string; name: string; kind: string; value: number; approvalThresholdBps: number; active: boolean }>(`SELECT id, name, kind, value, approval_threshold_bps, active FROM discounts WHERE active ORDER BY name`);
export async function createDiscount(db: Db, ctx: Ctx, input: z.infer<typeof discountSchema>) {
  const d = await db.one<{ id: string }>(`INSERT INTO discounts (org_id, name, kind, value, approval_threshold_bps) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.orgId, input.name, input.kind, input.value, input.approvalThresholdBps]);
  await audit(db, ctx, "discount.create", "discount", d.id, input);
  return d;
}

/* ───────── modifier groups ───────── */
export const modifierGroupSchema = z.object({
  name: z.string().trim().min(1).max(80), minSelect: z.number().int().min(0).max(10).default(0), maxSelect: z.number().int().min(1).max(10).default(1),
  modifiers: z.array(z.object({ name: z.string().trim().min(1).max(80), priceDeltaCents: z.number().int().min(-1_000_000).max(1_000_000).default(0) })).min(1).max(40),
}).refine((g) => g.maxSelect >= g.minSelect, { message: "maxSelect must be ≥ minSelect", path: ["maxSelect"] });

export async function createModifierGroup(db: Db, ctx: Ctx, input: z.infer<typeof modifierGroupSchema>) {
  const g = await db.one<{ id: string }>(`INSERT INTO modifier_groups (org_id, name, min_select, max_select) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.orgId, input.name, input.minSelect, input.maxSelect]);
  let i = 0;
  for (const m of input.modifiers) await db.exec(`INSERT INTO modifiers (org_id, group_id, name, price_delta_cents, sort) VALUES ($1,$2,$3,$4,$5)`, [ctx.orgId, g.id, m.name, m.priceDeltaCents, i++]);
  await audit(db, ctx, "modifier_group.create", "modifier_group", g.id, { name: input.name });
  return g;
}
export async function listModifierGroups(db: Db) {
  const groups = await db.query<{ id: string; name: string; minSelect: number; maxSelect: number }>(`SELECT id, name, min_select, max_select FROM modifier_groups ORDER BY name`);
  const mods = await db.query<{ id: string; groupId: string; name: string; priceDeltaCents: number; active: boolean }>(`SELECT id, group_id, name, price_delta_cents, active FROM modifiers ORDER BY sort, name`);
  return groups.map((g) => ({ ...g, modifiers: mods.filter((m) => m.groupId === g.id) }));
}

/* ───────── products ───────── */
export const productSchema = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable().optional(), sku: z.string().max(40).nullable().optional(),
  categoryId: z.uuid().nullable().optional(), priceCents: z.number().int().min(0).max(100_000_000), taxRateId: z.uuid(),
  stationKind: z.enum(["kitchen", "bar", "pastry", "none"]).default("kitchen"), defaultCourse: z.number().int().min(1).max(6).default(1),
  allergens: z.array(z.string().trim().min(1).max(30)).max(20).default([]), dietary: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  imageUrl: z.url().nullable().optional(), modifierGroupIds: z.array(z.uuid()).max(10).default([]), sort: z.number().int().min(0).max(10000).default(0),
});
export type ProductInput = z.infer<typeof productSchema>;

async function setProductGroups(db: Db, orgId: string, productId: string, ids: string[]) {
  await db.exec(`DELETE FROM product_modifier_groups WHERE product_id = $1`, [productId]);
  let i = 0;
  for (const g of ids) await db.exec(`INSERT INTO product_modifier_groups (org_id, product_id, group_id, sort) VALUES ($1,$2,$3,$4)`, [orgId, productId, g, i++]);
}

export async function createProduct(db: Db, ctx: Ctx, input: ProductInput) {
  const p = await db.one<{ id: string }>(
    `INSERT INTO products (org_id, category_id, name, description, sku, price_cents, tax_rate_id, station_kind, default_course, allergens, dietary, image_url, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.orgId, input.categoryId ?? null, input.name, input.description ?? null, input.sku ?? null, input.priceCents, input.taxRateId, input.stationKind, input.defaultCourse, input.allergens, input.dietary, input.imageUrl ?? null, input.sort]);
  await setProductGroups(db, ctx.orgId, p.id, input.modifierGroupIds);
  await audit(db, ctx, "product.create", "product", p.id, { name: input.name, priceCents: input.priceCents });
  return p;
}

export async function updateProduct(db: Db, ctx: Ctx, id: string, input: Partial<ProductInput> & { active?: boolean; available?: boolean }) {
  const before = await db.maybe<{ priceCents: number; available: boolean }>(`SELECT price_cents, available FROM products WHERE id = $1`, [id]);
  if (!before) throw notFound("Product");
  await db.exec(
    `UPDATE products SET name = COALESCE($2,name), description = COALESCE($3,description), sku = COALESCE($4,sku), category_id = COALESCE($5,category_id),
       price_cents = COALESCE($6,price_cents), tax_rate_id = COALESCE($7,tax_rate_id), station_kind = COALESCE($8,station_kind), default_course = COALESCE($9,default_course),
       allergens = COALESCE($10,allergens), dietary = COALESCE($11,dietary), image_url = COALESCE($12,image_url), sort = COALESCE($13,sort),
       active = COALESCE($14,active), available = COALESCE($15,available) WHERE id = $1`,
    [id, input.name ?? null, input.description ?? null, input.sku ?? null, input.categoryId ?? null, input.priceCents ?? null, input.taxRateId ?? null, input.stationKind ?? null,
     input.defaultCourse ?? null, input.allergens ?? null, input.dietary ?? null, input.imageUrl ?? null, input.sort ?? null, input.active ?? null, input.available ?? null]);
  if (input.modifierGroupIds) await setProductGroups(db, ctx.orgId, id, input.modifierGroupIds);
  await audit(db, ctx, input.priceCents !== undefined && input.priceCents !== before.priceCents ? "product.price_change" : "product.update", "product", id,
    { ...input, previousPriceCents: before.priceCents });
}

export const outletProductSchema = z.object({ priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(), available: z.boolean().optional(), hidden: z.boolean().optional() });
export async function setProductOutlet(db: Db, ctx: Ctx, productId: string, outletId: string, input: z.infer<typeof outletProductSchema>) {
  assertOutletAccess(ctx, outletId);
  if (!(await db.maybe(`SELECT 1 FROM products WHERE id = $1`, [productId]))) throw notFound("Product");
  if (!(await db.maybe(`SELECT 1 FROM outlets WHERE id = $1`, [outletId]))) throw notFound("Outlet");
  await db.exec(
    `INSERT INTO product_outlets (org_id, product_id, outlet_id, price_cents, available, hidden) VALUES ($1,$2,$3,$4,COALESCE($5,true),COALESCE($6,false))
     ON CONFLICT (product_id, outlet_id) DO UPDATE SET
       price_cents = CASE WHEN $7::boolean THEN $4 ELSE product_outlets.price_cents END,
       available = COALESCE($5, product_outlets.available), hidden = COALESCE($6, product_outlets.hidden)`,
    [ctx.orgId, productId, outletId, input.priceCents ?? null, input.available ?? null, input.hidden ?? null, input.priceCents !== undefined]);
  await audit(db, ctx, "product.outlet_override", "product", productId, input, { outletId });
}

export interface MenuProduct {
  id: string; categoryId: string | null; name: string; description: string | null; priceCents: number; taxRateBps: number; stationKind: string;
  defaultCourse: number; allergens: string[]; dietary: string[]; available: boolean; imageUrl: string | null;
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; priceDeltaCents: number }> }>;
}

/** Menu as seen at one outlet: outlet price/availability overrides applied, hidden/inactive items removed. */
export async function menuForOutlet(db: Db, ctx: Ctx, outletId: string) {
  await loadOutlet(db, ctx, outletId);
  const categories = await db.query<{ id: string; parentId: string | null; name: string; sort: number; color: string | null }>(`SELECT id, parent_id, name, sort, color FROM categories WHERE active ORDER BY sort, name`);
  const rows = await db.query<Omit<MenuProduct, "modifierGroups">>(
    `SELECT p.id, p.category_id, p.name, p.description, COALESCE(po.price_cents, p.price_cents) AS price_cents, t.rate_bps AS tax_rate_bps, p.station_kind, p.default_course,
            p.allergens, p.dietary, (p.available AND COALESCE(po.available, true)) AS available, p.image_url
       FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id LEFT JOIN product_outlets po ON po.product_id = p.id AND po.outlet_id = $1
      WHERE p.active AND NOT COALESCE(po.hidden, false) ORDER BY p.sort, p.name`, [outletId]);
  const groups = await listModifierGroups(db);
  const links = await db.query<{ productId: string; groupId: string }>(`SELECT product_id, group_id FROM product_modifier_groups ORDER BY sort`);
  const products: MenuProduct[] = rows.map((p) => ({
    ...p,
    modifierGroups: links.filter((l) => l.productId === p.id).map((l) => groups.find((g) => g.id === l.groupId)).filter(Boolean)
      .map((g) => ({ id: g!.id, name: g!.name, minSelect: g!.minSelect, maxSelect: g!.maxSelect, modifiers: g!.modifiers.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })) })),
  }));
  return { categories, products };
}

/** Back-office listing (all products, including inactive) */
export async function listProducts(db: Db) {
  return db.query<{ id: string; name: string; categoryId: string | null; priceCents: number; taxRateId: string; stationKind: string; defaultCourse: number; allergens: string[]; available: boolean; active: boolean; sku: string | null }>(
    `SELECT id, name, category_id, price_cents, tax_rate_id, station_kind, default_course, allergens, available, active, sku FROM products ORDER BY name`);
}

/* ───────── import / export ───────── */
export async function exportMenu(db: Db) {
  const categories = await db.query<{ id: string; name: string; parentId: string | null; sort: number }>(`SELECT id, name, parent_id, sort FROM categories ORDER BY sort, name`);
  const products = await db.query<{ name: string; description: string | null; sku: string | null; category: string | null; priceCents: number; taxRateBps: number; stationKind: string; defaultCourse: number; allergens: string[]; dietary: string[] }>(
    `SELECT p.name, p.description, p.sku, c.name AS category, p.price_cents, t.rate_bps AS tax_rate_bps, p.station_kind, p.default_course, p.allergens, p.dietary
       FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.active ORDER BY c.name NULLS FIRST, p.name`);
  return { version: 1, categories: categories.map((c) => ({ name: c.name, sort: c.sort })), products };
}

export const menuImportSchema = z.object({
  categories: z.array(z.object({ name: z.string().trim().min(1).max(80), sort: z.number().int().default(0) })).max(200).default([]),
  products: z.array(z.object({
    name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable().optional(), sku: z.string().max(40).nullable().optional(), category: z.string().nullable().optional(),
    priceCents: z.number().int().min(0).max(100_000_000), taxRateBps: z.number().int().min(0).max(10000),
    stationKind: z.enum(["kitchen", "bar", "pastry", "none"]).default("kitchen"), defaultCourse: z.number().int().min(1).max(6).default(1),
    allergens: z.array(z.string()).default([]), dietary: z.array(z.string()).default([]),
  })).max(2000),
});
/** Upserts by (name) within category/ SKU; never deletes. Unknown tax rates are rejected (no silent creation). */
export async function importMenu(db: Db, ctx: Ctx, input: z.infer<typeof menuImportSchema>) {
  const rates = new Map((await listTaxRates(db)).map((r) => [r.rateBps, r.id]));
  const cats = new Map((await db.query<{ id: string; name: string }>(`SELECT id, name FROM categories`)).map((c) => [c.name.toLowerCase(), c.id]));
  let createdCats = 0, created = 0, updated = 0;
  for (const c of input.categories) if (!cats.has(c.name.toLowerCase())) { cats.set(c.name.toLowerCase(), (await createCategory(db, ctx, { name: c.name, sort: c.sort })).id); createdCats++; }
  for (const p of input.products) {
    const taxRateId = rates.get(p.taxRateBps);
    if (!taxRateId) throw badRequest(`No tax rate of ${p.taxRateBps / 100}% is configured (product "${p.name}")`, "UNKNOWN_TAX_RATE");
    let categoryId: string | null = null;
    if (p.category) {
      categoryId = cats.get(p.category.toLowerCase()) ?? null;
      if (!categoryId) { categoryId = (await createCategory(db, ctx, { name: p.category, sort: 0 })).id; cats.set(p.category.toLowerCase(), categoryId); createdCats++; }
    }
    const existing = await db.maybe<{ id: string }>(`SELECT id FROM products WHERE (sku IS NOT NULL AND sku = $1) OR (sku IS NULL AND lower(name) = lower($2) AND category_id IS NOT DISTINCT FROM $3) LIMIT 1`, [p.sku ?? null, p.name, categoryId]);
    const data = { name: p.name, description: p.description ?? null, sku: p.sku ?? null, categoryId, priceCents: p.priceCents, taxRateId, stationKind: p.stationKind, defaultCourse: p.defaultCourse, allergens: p.allergens, dietary: p.dietary, modifierGroupIds: [], sort: 0 };
    if (existing) { const { modifierGroupIds: _m, ...upd } = data; void _m; await updateProduct(db, ctx, existing.id, upd); updated++; }
    else { await createProduct(db, ctx, data); created++; }
  }
  await audit(db, ctx, "menu.import", "menu", null, { created, updated, createdCats });
  return { created, updated, createdCategories: createdCats };
}
