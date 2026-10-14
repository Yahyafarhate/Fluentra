import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { withSystem } from "@/lib/db";
import { assertLocationAccess, type Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { badRequest, notFound } from "@/lib/errors";
import { requireFeature } from "../billing/limits";

const MAX = 2 * 1024 * 1024;
/** Content type is derived from the file's magic bytes — never from the client-provided type or file name. */
export function sniffImage(buf: Buffer): { type: string; ext: string } | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", ext: "png" };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

/** Storage adapter boundary: swap for S3-compatible object storage in production. */
export const storage = {
  async put(key: string, data: Buffer) {
    const file = path.resolve(env.uploadDir, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, { mode: 0o640 });
  },
  async get(key: string): Promise<Buffer> {
    const base = path.resolve(env.uploadDir);
    const file = path.resolve(base, key);
    if (!file.startsWith(base + path.sep)) throw notFound("File");
    return fs.readFile(file);
  },
};

export async function saveImage(db: Db, ctx: Ctx, locationId: string, kind: "logo" | "cover" | "gallery", data: Buffer) {
  assertLocationAccess(ctx, locationId);
  await requireFeature(db, ctx.orgId, "custom_branding");
  if (data.length === 0) throw badRequest("Empty file", "EMPTY_FILE");
  if (data.length > MAX) throw badRequest("Image must be 2 MB or smaller", "FILE_TOO_LARGE");
  const img = sniffImage(data);
  if (!img) throw badRequest("Only PNG, JPEG or WebP images are accepted", "UNSUPPORTED_FILE");
  const loc = await db.maybe(`SELECT 1 FROM locations WHERE id=$1 AND org_id=$2`, [locationId, ctx.orgId]);
  if (!loc) throw notFound("Location");
  const id = randomUUID();
  const key = `${ctx.orgId}/${id}.${img.ext}`;
  const inDb = env.storageDriver === "db";
  if (!inDb) await storage.put(key, data);
  await db.exec(`INSERT INTO uploads (id, org_id, location_id, kind, content_type, size, storage_key, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, ctx.orgId, locationId, kind, img.type, data.length, inDb ? null : key, inDb ? data : null, ctx.user.id]);
  const url = `/api/files/${id}`;
  if (kind === "logo") await db.exec(`UPDATE locations SET logo_url=$2 WHERE id=$1`, [locationId, url]);
  else if (kind === "cover") await db.exec(`UPDATE locations SET cover_url=$2 WHERE id=$1`, [locationId, url]);
  else await db.exec(`UPDATE locations SET gallery = (gallery || $2::text)[GREATEST(1, cardinality(gallery || $2::text) - 11):] WHERE id=$1`, [locationId, url]);
  await audit(db, ctx, "upload.image", "upload", id, { kind, size: data.length });
  return { id, url };
}

/** Public serving: only branding images of locations that are active and belong to a live organization. */
export async function readPublicFile(id: string) {
  const f = await withSystem((db) => db.maybe<{ storageKey: string | null; contentType: string; data: Buffer | null }>(
    `SELECT u.storage_key, u.content_type, u.data FROM uploads u JOIN locations l ON l.id=u.location_id AND l.status='active' JOIN organizations o ON o.id=u.org_id AND o.status <> 'cancelled' WHERE u.id=$1`, [id]));
  if (!f) throw notFound("File");
  if (f.data) return { data: f.data, contentType: f.contentType };
  if (!f.storageKey) throw notFound("File");
  return { data: await storage.get(f.storageKey), contentType: f.contentType };
}
