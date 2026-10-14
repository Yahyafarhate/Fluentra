import type { Db } from "./db";
import type { Ctx } from "./auth";

export async function audit(
  db: Db,
  ctx: Pick<Ctx, "orgId" | "user"> | null,
  action: string,
  entityType?: string,
  entityId?: string | null,
  metadata: Record<string, unknown> = {},
  opts: { orgId?: string | null; ip?: string | null } = {},
) {
  await db.exec(
    `INSERT INTO audit_logs (org_id, actor_user_id, actor_label, action, entity_type, entity_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [opts.orgId ?? ctx?.orgId ?? null, ctx?.user.id ?? null, ctx?.user.email ?? "system", action, entityType ?? null, entityId ?? null, JSON.stringify(metadata), opts.ip ?? null],
  );
}
