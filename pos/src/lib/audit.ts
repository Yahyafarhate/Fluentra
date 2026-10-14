import type { Db } from "./db";
import type { Ctx } from "./auth";

export interface AuditExtra { orderId?: string | null; approverId?: string | null; ip?: string | null; outletId?: string | null }

/** Append-only audit trail. The runtime DB role cannot UPDATE or DELETE rows of this table. */
export async function audit(
  db: Db,
  ctx: Pick<Ctx, "orgId" | "employee"> | null,
  action: string,
  entityType?: string,
  entityId?: string | null,
  metadata: Record<string, unknown> = {},
  extra: AuditExtra & { orgId?: string | null } = {},
) {
  await db.exec(
    `INSERT INTO audit_logs (org_id, outlet_id, actor_id, actor_label, approver_id, action, entity_type, entity_id, order_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [extra.orgId ?? ctx?.orgId ?? null, extra.outletId ?? null, ctx?.employee.id ?? null, ctx?.employee.name ?? "system", extra.approverId ?? null,
     action, entityType ?? null, entityId ?? null, extra.orderId ?? null, JSON.stringify(metadata), extra.ip ?? null],
  );
}
