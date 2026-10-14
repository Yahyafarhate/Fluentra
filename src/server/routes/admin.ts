import { z } from "zod";
import { Router } from "../http/router";
import { json, superAdmin } from "@/lib/api";
import { createOrgSchema, createOrganization, getOrganizationDetail, listOrganizations, orgPatchSchema, platformAudit, platformOverview, reactivateOrganization, suspendOrganization, updateOrganization } from "../admin/service";
import { withSystem } from "@/lib/db";
import { runDueJobs } from "../notifications/jobs";
import { scheduleTick } from "../automation/service";

export const adminRouter = new Router("/api/admin");
const sa = (method: string, path: string, summary: string, h: Parameters<typeof superAdmin>[0]) => adminRouter.add(method, path, "super admin", summary, superAdmin(h));

sa("GET", "/overview", "Platform KPIs, plan distribution and system health", async () => platformOverview());
sa("GET", "/organizations", "List tenant organizations", async (a) => ({ organizations: await listOrganizations(a.url.searchParams.get("q") ?? undefined) }));
sa("POST", "/organizations", "Create an organization with its owner", async (a) => json(await createOrganization(a.ctx, await a.body(createOrgSchema)), 201));
sa("GET", "/organizations/:id", "Organization detail & support view", async (a) => getOrganizationDetail(z.string().uuid().parse(a.params.id)));
sa("PATCH", "/organizations/:id", "Change plan / status / extend trial", async (a) => { await updateOrganization(a.ctx, z.string().uuid().parse(a.params.id), await a.body(orgPatchSchema)); return { ok: true }; });
sa("POST", "/organizations/:id/suspend", "Suspend an account (data is retained)", async (a) => {
  const { reason } = await a.body(z.object({ reason: z.string().trim().min(3).max(300) }));
  await suspendOrganization(a.ctx, z.string().uuid().parse(a.params.id), reason);
  return { ok: true };
});
sa("POST", "/organizations/:id/reactivate", "Reactivate a suspended account", async (a) => { await reactivateOrganization(a.ctx, z.string().uuid().parse(a.params.id)); return { ok: true }; });
sa("GET", "/audit", "Platform-wide audit log", async (a) => ({ entries: await platformAudit(a.url.searchParams.get("before") ? Number(a.url.searchParams.get("before")) : undefined) }));
sa("GET", "/plans", "Subscription plans", async () => ({ plans: await withSystem((db) => db.query(`SELECT * FROM plans ORDER BY sort`)) }));
sa("POST", "/jobs/run", "Run due background jobs now (support tool)", async () => { await scheduleTick(); return runDueJobs(50); });
