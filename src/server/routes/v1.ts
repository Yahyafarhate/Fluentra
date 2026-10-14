import { z } from "zod";
import { Router } from "../http/router";
import { authed, json } from "@/lib/api";
import { withOrg, withSystem } from "@/lib/db";
import { assertLocationAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/errors";
import { isDateStr } from "@/lib/time";
import { rateLimit } from "@/lib/ratelimit";
import type { Permission } from "@/lib/rbac";

import { bookingInputSchema, createReservation, getReservation, listFilterSchema, listReservations, seatWalkIn, transitionReservation, transitionSchema, updateReservation, updateSchema, walkInSchema } from "../reservations/service";
import { computeSlots, loadLocation } from "../availability/service";
import {
  comboSchema, createCombination, createFloor, createSection, createTable, deleteCombination, deleteFloor, deleteSection, deleteTable, floorSchema, getFloorState, getTimeline,
  layoutSchema, saveLayout, sectionSchema, setTableStatus, tableInputSchema, tablePatchSchema, tableStatusSchema, timelineQuery, updateFloor, updateTable,
} from "../floor/service";
import { addToWaitlist, estimateWait, listWaitlist, waitlistActionSchema, waitlistAction, waitlistInputSchema, waitlistStats } from "../waitlist/service";
import {
  anonymizeCustomer, createCustomer, customerInputSchema, exportCustomerData, getCustomerProfile, mergeCustomers, queryCustomers, recordConsent, segmentCriteriaSchema, updateCustomer, channelSchema,
} from "../customers/service";
import { getDashboard } from "../dashboard/service";
import { analyticsQuerySchema, exportReservationsCsv, getAnalytics, getForecast, toCsv } from "../analytics/service";
import {
  archiveLocation, createLocation, deleteService, deleteSpecialDay, locationPatchSchema, newLocationSchema, serviceSchema, specialDaySchema, updateLocation, upsertService, upsertSpecialDay,
} from "../tenants/locations";
import { inviteSchema, inviteMember, listTeam, memberPatchSchema, removeMember, revokeInvitation, updateMember } from "../tenants/team";
import { integrationOverview, listAudit, listTemplates, previewTemplate, resetTemplate, saveTemplate, sendTestMessage, templateSchema } from "../tenants/settings";
import { saveImage } from "../tenants/uploads";
import { conditionsSchema, ruleInputSchema, TRIGGERS } from "../automation/service";
import {
  campaignAudience, campaignResults, campaignSchema, cancelCampaign, createCampaign, createOffer, createSegment, deleteSegment, launchCampaign, listCampaigns, listOffers, listSegments,
  offerSchema, previewAudience, retentionMetrics, scheduleSchema, segmentSchema, setOfferActive,
} from "../marketing/service";
import { changePlan, changePlanSchema, getBilling } from "../billing/service";
import { getUsage, getPlanInfo, requireFeature } from "../billing/limits";

export const v1 = new Router("/api/v1");

/** Register a tenant-scoped endpoint. `perm` is enforced on the server before the handler runs. */
function def<P extends Permission | Permission[] | null>(method: string, path: string, perm: P, summary: string, handler: Parameters<typeof authed>[1]) {
  v1.add(method, path, perm === null ? "any member" : Array.isArray(perm) ? perm.join(" + ") : perm, summary, authed(perm, handler));
}
const uuid = z.string().uuid();
const dateStr = z.string().refine(isDateStr, "Invalid date");

// ───────────── Locations & schedule ─────────────
def("GET", "/locations", null, "Locations the caller may access", async ({ ctx }) =>
  withOrg(ctx.orgId, (db) => db.query(`SELECT id, name, slug, status, timezone, city, address, phone, currency, default_locale, online_booking_enabled FROM locations WHERE org_id=$1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY status, name`, [ctx.orgId, ctx.locationIds])));
def("POST", "/locations", "locations.manage", "Create a location (plan limits enforced)", async (a) => {
  const input = await a.body(newLocationSchema);
  return json(await withOrg(a.ctx.orgId, (db) => createLocation(db, a.ctx, input)), 201);
});
def("GET", "/locations/:id", "settings.manage", "Full location settings", async ({ ctx, params }) => {
  assertLocationAccess(ctx, params.id);
  return withOrg(ctx.orgId, async (db) => {
    const loc = await db.maybe(`SELECT * FROM locations WHERE id=$1 AND org_id=$2`, [params.id, ctx.orgId]);
    if (!loc) throw notFound("Location");
    const services = await db.query(`SELECT id, name, days, to_char(start_time,'HH24:MI') AS start_time, to_char(last_seating,'HH24:MI') AS last_seating, slot_interval_min, max_covers, active FROM services WHERE location_id=$1 ORDER BY start_time`, [params.id]);
    const specialDays = await db.query(`SELECT id, date, closed, label, to_char(start_time,'HH24:MI') AS start_time, to_char(last_seating,'HH24:MI') AS last_seating FROM special_days WHERE location_id=$1 AND date >= current_date - 7 ORDER BY date`, [params.id]);
    return { location: loc, services, specialDays };
  });
});
def("PATCH", "/locations/:id", "settings.manage", "Update restaurant profile & booking policy", async (a) => {
  const patch = await a.body(locationPatchSchema);
  await withOrg(a.ctx.orgId, (db) => updateLocation(db, a.ctx, a.params.id, patch));
  return { ok: true };
});
def("DELETE", "/locations/:id", "locations.manage", "Archive a location (data retained)", async (a) => {
  await withOrg(a.ctx.orgId, (db) => archiveLocation(db, a.ctx, a.params.id));
  return { ok: true };
});
def("POST", "/locations/:id/upload", "settings.manage", "Upload a logo/cover/gallery image (raw body; ?kind=logo|cover|gallery)", async (a) => {
  const kind = z.enum(["logo", "cover", "gallery"]).parse(a.url.searchParams.get("kind"));
  const buf = Buffer.from(await a.req.arrayBuffer());
  return json(await withOrg(a.ctx.orgId, (db) => saveImage(db, a.ctx, a.params.id, kind, buf)), 201);
});
def("POST", "/services", "settings.manage", "Create a service period (opening hours)", async (a) => {
  const input = await a.body(serviceSchema);
  return json(await withOrg(a.ctx.orgId, (db) => upsertService(db, a.ctx, input)), 201);
});
def("PUT", "/services/:id", "settings.manage", "Update a service period", async (a) => {
  const input = await a.body(serviceSchema);
  return withOrg(a.ctx.orgId, (db) => upsertService(db, a.ctx, input, a.params.id));
});
def("DELETE", "/services/:id", "settings.manage", "Delete a service period", async (a) => {
  await withOrg(a.ctx.orgId, (db) => deleteService(db, a.ctx, a.params.id));
  return { ok: true };
});
def("POST", "/special-days", "settings.manage", "Set a holiday / special opening day", async (a) => {
  const input = await a.body(specialDaySchema);
  return withOrg(a.ctx.orgId, (db) => upsertSpecialDay(db, a.ctx, input));
});
def("DELETE", "/special-days/:id", "settings.manage", "Remove a special day", async (a) => {
  await withOrg(a.ctx.orgId, (db) => deleteSpecialDay(db, a.ctx, a.params.id));
  return { ok: true };
});

// ───────────── Reservations ─────────────
def("GET", "/availability", "reservations.read", "Available slots (staff view, includes suggested tables)", async (a) => {
  const q = a.query(z.object({ locationId: uuid, date: dateStr, partySize: z.coerce.number().int().min(1).max(500), channel: z.enum(["staff", "online"]).default("staff") }));
  assertLocationAccess(a.ctx, q.locationId);
  return withOrg(a.ctx.orgId, async (db) => {
    const loc = await loadLocation(db, q.locationId);
    const res = await computeSlots(db, loc, q.date, { channel: q.channel, partySize: q.partySize });
    const names = await db.query<{ id: string; name: string }>(`SELECT id, name FROM tables WHERE location_id=$1`, [q.locationId]);
    return { ...res, slots: res.slots.map((s) => ({ ...s, tables: s.tableIds?.map((id) => names.find((n) => n.id === id)?.name) })) };
  });
});
def("GET", "/reservations", "reservations.read", "Search / filter reservations", async (a) => {
  const f = a.query(listFilterSchema);
  return withOrg(a.ctx.orgId, async (db) => ({ reservations: await listReservations(db, a.ctx, f) }));
});
def("POST", "/reservations", "reservations.write", "Create a reservation (atomic table allocation)", async (a) => {
  const input = await a.body(bookingInputSchema);
  return json(await createReservation(a.ctx, input), 201);
});
def("GET", "/reservations/:id", "reservations.read", "Reservation detail with guest context", async (a) =>
  withOrg(a.ctx.orgId, (db) => getReservation(db, a.ctx, a.params.id)));
def("PATCH", "/reservations/:id", "reservations.write", "Edit / reschedule / reassign tables", async (a) => {
  const input = await a.body(updateSchema);
  return updateReservation(a.ctx, a.params.id, input);
});
def("POST", "/reservations/:id/transition", "reservations.operate", "Status action: confirm, arrive, seat, complete, cancel, no_show, undo_*", async (a) => {
  const input = await a.body(transitionSchema);
  return transitionReservation(a.ctx, a.params.id, input);
});
def("POST", "/walk-ins", "reservations.operate", "Seat a walk-in party immediately", async (a) => {
  const input = await a.body(walkInSchema);
  return json(await seatWalkIn(a.ctx, input), 201);
});

// ───────────── Floor plan ─────────────
def("GET", "/floor/state", "floor.view", "Live floor state with derived table statuses", async (a) => {
  const q = a.query(z.object({ locationId: uuid, at: z.string().datetime().optional(), horizonMin: z.coerce.number().int().min(15).max(480).optional() }));
  return withOrg(a.ctx.orgId, (db) => getFloorState(db, a.ctx, q.locationId, { at: q.at ? new Date(q.at) : undefined, horizonMin: q.horizonMin }));
});
def("GET", "/floor/timeline", "floor.view", "Table occupancy timeline for a day", async (a) => {
  const q = a.query(timelineQuery);
  return withOrg(a.ctx.orgId, (db) => getTimeline(db, a.ctx, q.locationId, q.date));
});
def("POST", "/floor/tables", "floor.manage", "Add a table", async (a) => {
  const input = await a.body(tableInputSchema);
  return json(await withOrg(a.ctx.orgId, (db) => createTable(db, a.ctx, input)), 201);
});
def("PATCH", "/floor/tables/:id", "floor.manage", "Edit a table (name, capacity, shape, geometry…)", async (a) => {
  const patch = await a.body(tablePatchSchema);
  await withOrg(a.ctx.orgId, (db) => updateTable(db, a.ctx, a.params.id, patch));
  return { ok: true };
});
def("DELETE", "/floor/tables/:id", "floor.manage", "Remove (or archive) a table", async (a) => {
  await withOrg(a.ctx.orgId, (db) => deleteTable(db, a.ctx, a.params.id));
  return { ok: true };
});
def("POST", "/floor/tables/:id/status", "floor.operate", "Mark ready / awaiting cleaning / blocked", async (a) => {
  const input = await a.body(tableStatusSchema);
  await withOrg(a.ctx.orgId, (db) => setTableStatus(db, a.ctx, a.params.id, input));
  return { ok: true };
});
def("PUT", "/floor/layout", "floor.manage", "Persist the whole layout atomically", async (a) => {
  const input = await a.body(layoutSchema);
  await withOrg(a.ctx.orgId, (db) => saveLayout(db, a.ctx, input));
  return { ok: true };
});
def("POST", "/floor/floors", "floor.manage", "Create a floor", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createFloor(db, a.ctx, await a.body(floorSchema))), 201));
def("PATCH", "/floor/floors/:id", "floor.manage", "Rename / resize a floor", async (a) => {
  const patch = await a.body(floorSchema.omit({ locationId: true }).partial());
  await withOrg(a.ctx.orgId, (db) => updateFloor(db, a.ctx, a.params.id, patch));
  return { ok: true };
});
def("DELETE", "/floor/floors/:id", "floor.manage", "Delete an empty floor", async (a) => { await withOrg(a.ctx.orgId, (db) => deleteFloor(db, a.ctx, a.params.id)); return { ok: true }; });
def("POST", "/floor/sections", "floor.manage", "Create a dining section", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createSection(db, a.ctx, await a.body(sectionSchema))), 201));
def("DELETE", "/floor/sections/:id", "floor.manage", "Delete a dining section", async (a) => { await withOrg(a.ctx.orgId, (db) => deleteSection(db, a.ctx, a.params.id)); return { ok: true }; });
def("POST", "/floor/combinations", "floor.manage", "Define a compatible table combination", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createCombination(db, a.ctx, await a.body(comboSchema))), 201));
def("DELETE", "/floor/combinations/:id", "floor.manage", "Delete a table combination", async (a) => { await withOrg(a.ctx.orgId, (db) => deleteCombination(db, a.ctx, a.params.id)); return { ok: true }; });

// ───────────── Waitlist ─────────────
def("GET", "/waitlist", "waitlist.manage", "Active waitlist with live wait estimates", async (a) => {
  const q = a.query(z.object({ locationId: uuid, includeClosed: z.enum(["true", "false"]).optional() }));
  return withOrg(a.ctx.orgId, (db) => listWaitlist(db, a.ctx, q.locationId, { includeClosed: q.includeClosed === "true" }));
});
def("POST", "/waitlist", "waitlist.manage", "Add a party to the waitlist", async (a) => {
  const input = await a.body(waitlistInputSchema);
  return json(await withOrg(a.ctx.orgId, (db) => addToWaitlist(db, a.ctx, input)), 201);
});
def("GET", "/waitlist/estimate", "waitlist.manage", "Estimated wait for a new party (not a guarantee)", async (a) => {
  const q = a.query(z.object({ locationId: uuid, partySize: z.coerce.number().int().min(1).max(100) }));
  assertLocationAccess(a.ctx, q.locationId);
  return withOrg(a.ctx.orgId, async (db) => ({ ...(await estimateWait(db, await loadLocation(db, q.locationId), q.partySize)), isEstimate: true }));
});
def("GET", "/waitlist/stats", "waitlist.manage", "Average wait & conversion", async (a) => {
  const q = a.query(z.object({ locationId: uuid.optional(), days: z.coerce.number().int().min(1).max(365).default(30) }));
  if (q.locationId) assertLocationAccess(a.ctx, q.locationId);
  return withOrg(a.ctx.orgId, (db) => waitlistStats(db, a.ctx.orgId, q.locationId ?? null, q.days));
});
def("POST", "/waitlist/:id/action", "waitlist.manage", "notify | seat | remove | cancel | link_customer | update", async (a) => {
  const input = await a.body(waitlistActionSchema);
  return waitlistAction(a.ctx, a.params.id, input);
});

// ───────────── Customers (CRM) ─────────────
const customerListQuery = segmentCriteriaSchema.extend({
  minVisits: z.coerce.number().int().min(0).optional(), maxVisits: z.coerce.number().int().min(0).optional(), lastVisitWithinDays: z.coerce.number().int().min(1).optional(),
  lapsedDays: z.coerce.number().int().min(1).optional(), neverVisited: z.enum(["true"]).transform(() => true).optional(), vip: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  hasAllergies: z.enum(["true"]).transform(() => true).optional(), birthdayWithinDays: z.coerce.number().int().min(0).max(366).optional(), minSpend: z.coerce.number().min(0).optional(),
  tags: z.string().transform((s) => s.split(",").filter(Boolean)).optional(),
  sort: z.enum(["name", "recent", "visits", "created"]).default("name"), limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
});
def("GET", "/customers", "customers.read", "Search / filter guests", async (a) => {
  const { sort, limit, offset, ...criteria } = a.query(customerListQuery);
  return withOrg(a.ctx.orgId, (db) => queryCustomers(db, a.ctx.orgId, criteria, { sort, limit, offset }));
});
def("GET", "/customers/export.csv", "customers.export", "Export the (filtered) guest list as CSV — audited", async (a) => {
  const { sort, limit: _l, offset: _o, ...criteria } = a.query(customerListQuery);
  void _l; void _o;
  await rateLimit(`export:${a.ctx.user.id}`, 10, 3600);
  const rows = await withOrg(a.ctx.orgId, async (db) => {
    const r = await queryCustomers(db, a.ctx.orgId, criteria, { sort, limit: 5000 });
    await audit(db, a.ctx, "customer.export_list", "customer", null, { count: r.rows.length });
    return r.rows;
  });
  const csv = toCsv(rows.map((r) => ({ name: r.name, phone: r.phone, email: r.email, vip: r.vip, visits: r.visits, lastVisit: r.lastVisit, consentEmail: r.consentEmail, consentSms: r.consentSms, consentWhatsapp: r.consentWhatsapp })),
    ["name", "phone", "email", "vip", "visits", "lastVisit", "consentEmail", "consentSms", "consentWhatsapp"]);
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="guests.csv"' } });
});
def("POST", "/customers", "customers.write", "Create a guest profile", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createCustomer(db, a.ctx, await a.body(customerInputSchema))), 201));
def("GET", "/customers/:id", "customers.read", "Guest profile, history, feedback, consents", async (a) => withOrg(a.ctx.orgId, (db) => getCustomerProfile(db, a.ctx, a.params.id)));
def("PATCH", "/customers/:id", "customers.write", "Edit a guest profile", async (a) => {
  const patch = await a.body(customerInputSchema.partial());
  await withOrg(a.ctx.orgId, (db) => updateCustomer(db, a.ctx, a.params.id, patch));
  return { ok: true };
});
def("POST", "/customers/merge", "customers.merge", "Merge a duplicate profile into another (audited)", async (a) => {
  const { sourceId, targetId } = await a.body(z.object({ sourceId: uuid, targetId: uuid }));
  await withOrg(a.ctx.orgId, (db) => mergeCustomers(db, a.ctx, sourceId, targetId));
  return { ok: true };
});
def("POST", "/customers/:id/consent", "customers.write", "Record a consent grant or withdrawal", async (a) => {
  const { channel, granted, note } = await a.body(z.object({ channel: channelSchema, granted: z.boolean(), note: z.string().max(300).optional() }));
  await withOrg(a.ctx.orgId, async (db) => { await recordConsent(db, a.ctx.orgId, a.params.id, channel, granted, "staff", a.ctx.user.id, note); await audit(db, a.ctx, "customer.consent", "customer", a.params.id, { channel, granted }); });
  return { ok: true };
});
def("GET", "/customers/:id/data-export", "customers.privacy", "Download all personal data held about a guest (JSON)", async (a) => {
  const data = await withOrg(a.ctx.orgId, (db) => exportCustomerData(db, a.ctx, a.params.id));
  return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="guest-${a.params.id}.json"` } });
});
def("POST", "/customers/:id/erase", "customers.privacy", "Right-to-erasure: irreversibly anonymize a guest", async (a) => {
  await a.body(z.object({ confirm: z.literal(true) }));
  await withOrg(a.ctx.orgId, (db) => anonymizeCustomer(db, a.ctx, a.ctx.orgId, a.params.id));
  return { ok: true };
});

// ───────────── Dashboard & analytics ─────────────
def("GET", "/dashboard", "dashboard.view", "Operational dashboard figures", async (a) => {
  const q = a.query(z.object({ locationId: uuid.optional(), date: dateStr.optional(), from: dateStr.optional(), to: dateStr.optional(), serviceId: uuid.optional() }));
  return withOrg(a.ctx.orgId, (db) => getDashboard(db, a.ctx, q));
});
def("GET", "/analytics", "analytics.view", "Reports & KPIs for a date range", async (a) => {
  const q = a.query(analyticsQuerySchema);
  return withOrg(a.ctx.orgId, async (db) => { await requireFeature(db, a.ctx.orgId, "analytics"); return getAnalytics(db, a.ctx, q); });
});
def("GET", "/analytics/forecast", "analytics.view", "14-day covers forecast (estimate)", async (a) => {
  const q = a.query(z.object({ locationId: uuid.optional() }));
  return withOrg(a.ctx.orgId, (db) => getForecast(db, a.ctx, q.locationId));
});
def("GET", "/analytics/export.csv", "analytics.export", "Download reservations for the range as CSV", async (a) => {
  const q = a.query(analyticsQuerySchema);
  const csv = await withOrg(a.ctx.orgId, async (db) => { await requireFeature(db, a.ctx.orgId, "analytics_export"); await audit(db, a.ctx, "analytics.export", "report", null, q); return exportReservationsCsv(db, a.ctx, q); });
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="reservations-${q.from}_${q.to}.csv"` } });
});
def("GET", "/analytics/summary.csv", "analytics.export", "Download daily summary as CSV", async (a) => {
  const q = a.query(analyticsQuerySchema);
  const csv = await withOrg(a.ctx.orgId, async (db) => { await requireFeature(db, a.ctx.orgId, "analytics_export"); const r = await getAnalytics(db, a.ctx, q); return toCsv(r.daily, ["date", "reservations", "covers", "cancelled", "noShow", "walkIns"]); });
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="daily-${q.from}_${q.to}.csv"` } });
});

// ───────────── Marketing ─────────────
def("GET", "/marketing/segments", "marketing.manage", "Saved segments with reachable audience sizes", async (a) => withOrg(a.ctx.orgId, (db) => listSegments(db, a.ctx)));
def("POST", "/marketing/segments", "marketing.manage", "Create a segment", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createSegment(db, a.ctx, await a.body(segmentSchema))), 201));
def("DELETE", "/marketing/segments/:id", "marketing.manage", "Delete a segment", async (a) => { await withOrg(a.ctx.orgId, (db) => deleteSegment(db, a.ctx, a.params.id)); return { ok: true }; });
def("POST", "/marketing/segments/preview", "marketing.manage", "Count guests matching criteria", async (a) => {
  const criteria = await a.body(segmentCriteriaSchema);
  return withOrg(a.ctx.orgId, async (db) => { await requireFeature(db, a.ctx.orgId, "marketing"); const r = await queryCustomers(db, a.ctx.orgId, criteria, { limit: 5 }); return { total: r.total, sample: r.rows.map((x) => ({ id: x.id, name: x.name })) }; });
});
def("GET", "/marketing/offers", "marketing.manage", "Offers", async (a) => withOrg(a.ctx.orgId, (db) => listOffers(db, a.ctx)));
def("POST", "/marketing/offers", "marketing.manage", "Create an offer", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createOffer(db, a.ctx, await a.body(offerSchema))), 201));
def("POST", "/marketing/offers/:id/toggle", "marketing.manage", "Activate / deactivate an offer", async (a) => {
  const { active } = await a.body(z.object({ active: z.boolean() }));
  await withOrg(a.ctx.orgId, (db) => setOfferActive(db, a.ctx, a.params.id, active));
  return { ok: true };
});
def("GET", "/marketing/campaigns", "marketing.manage", "Campaigns", async (a) => withOrg(a.ctx.orgId, (db) => listCampaigns(db, a.ctx)));
def("POST", "/marketing/campaigns", "marketing.manage", "Create a draft campaign", async (a) => json(await withOrg(a.ctx.orgId, async (db) => createCampaign(db, a.ctx, await a.body(campaignSchema))), 201));
def("GET", "/marketing/campaigns/:id/audience", "marketing.manage", "Consent-filtered audience preview", async (a) => withOrg(a.ctx.orgId, (db) => previewAudience(db, a.ctx, a.params.id)));
def("POST", "/marketing/campaigns/:id/launch", "marketing.manage", "Send now or schedule", async (a) => {
  const { sendAt } = await a.body(scheduleSchema);
  return withOrg(a.ctx.orgId, (db) => launchCampaign(db, a.ctx, a.params.id, sendAt));
});
def("POST", "/marketing/campaigns/:id/cancel", "marketing.manage", "Cancel a draft / scheduled campaign", async (a) => { await withOrg(a.ctx.orgId, (db) => cancelCampaign(db, a.ctx, a.params.id)); return { ok: true }; });
def("GET", "/marketing/campaigns/:id/results", "marketing.manage", "Delivery vs engagement vs attributed bookings", async (a) => withOrg(a.ctx.orgId, (db) => campaignResults(db, a.ctx, a.params.id)));
def("GET", "/marketing/retention", "marketing.manage", "Retention metrics", async (a) => withOrg(a.ctx.orgId, async (db) => { await requireFeature(db, a.ctx.orgId, "marketing"); return retentionMetrics(db, a.ctx); }));

// ───────────── Automations, templates, notifications, integrations ─────────────
def("GET", "/automations", "automations.manage", "Automation rules", async (a) => withOrg(a.ctx.orgId, async (db) => ({
  rules: await db.query(`SELECT r.*, (SELECT count(*) FROM automation_runs ar WHERE ar.rule_id=r.id)::int AS runs, (SELECT count(*) FROM automation_runs ar WHERE ar.rule_id=r.id AND ar.status='failed')::int AS failures,
                                 (SELECT max(created_at) FROM automation_runs ar WHERE ar.rule_id=r.id) AS last_run FROM automation_rules r WHERE r.org_id=$1 ORDER BY r.is_system DESC, r.created_at`, [a.ctx.orgId]),
  triggers: TRIGGERS, canCreateCustom: (await getPlanInfo(db, a.ctx.orgId)).features.includes("automations"),
})));
def("POST", "/automations", "automations.manage", "Create a custom rule (plan feature)", async (a) => {
  const input = await a.body(ruleInputSchema);
  return json(await withOrg(a.ctx.orgId, async (db) => {
    await requireFeature(db, a.ctx.orgId, "automations");
    if (input.locationId) assertLocationAccess(a.ctx, input.locationId);
    const r = await db.one<{ id: string }>(`INSERT INTO automation_rules (org_id, location_id, name, trigger, offset_minutes, conditions, channel, template_key, enabled, max_attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [a.ctx.orgId, input.locationId ?? null, input.name, input.trigger, input.offsetMinutes, JSON.stringify(input.conditions), input.channel, input.templateKey, input.enabled, input.maxAttempts]);
    await audit(db, a.ctx, "automation.create", "automation_rule", r.id, { name: input.name });
    return r;
  }), 201);
});
def("PATCH", "/automations/:id", "automations.manage", "Enable/disable or edit a rule", async (a) => {
  const patch = await a.body(z.object({ enabled: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional(), offsetMinutes: z.number().int().min(-43200).max(43200).optional(), conditions: conditionsSchema.optional(), channel: channelSchema.optional(), templateKey: z.string().max(60).optional(), maxAttempts: z.number().int().min(1).max(10).optional() }));
  await withOrg(a.ctx.orgId, async (db) => {
    const r = await db.maybe<{ isSystem: boolean }>(`SELECT is_system FROM automation_rules WHERE id=$1 AND org_id=$2 FOR UPDATE`, [a.params.id, a.ctx.orgId]);
    if (!r) throw notFound("Rule");
    await db.exec(`UPDATE automation_rules SET enabled=COALESCE($3,enabled), name=COALESCE($4,name), offset_minutes=COALESCE($5,offset_minutes), conditions=COALESCE($6,conditions), channel=COALESCE($7,channel), template_key=COALESCE($8,template_key), max_attempts=COALESCE($9,max_attempts) WHERE id=$1 AND org_id=$2`,
      [a.params.id, a.ctx.orgId, patch.enabled ?? null, patch.name ?? null, patch.offsetMinutes ?? null, patch.conditions ? JSON.stringify(patch.conditions) : null, patch.channel ?? null, patch.templateKey ?? null, patch.maxAttempts ?? null]);
    await audit(db, a.ctx, "automation.update", "automation_rule", a.params.id, patch as Record<string, unknown>);
  });
  return { ok: true };
});
def("DELETE", "/automations/:id", "automations.manage", "Delete a custom rule (system rules can only be disabled)", async (a) => {
  await withOrg(a.ctx.orgId, async (db) => {
    const n = await db.exec(`DELETE FROM automation_rules WHERE id=$1 AND org_id=$2 AND NOT is_system`, [a.params.id, a.ctx.orgId]);
    if (!n) throw badRequest("Rule not found or is a built-in rule (disable it instead)", "NOT_DELETABLE");
    await audit(db, a.ctx, "automation.delete", "automation_rule", a.params.id);
  });
  return { ok: true };
});
def("GET", "/automations/:id/runs", "automations.manage", "Execution history of a rule", async (a) =>
  withOrg(a.ctx.orgId, (db) => db.query(
    `SELECT ar.id, ar.status, ar.detail, ar.attempts, ar.created_at, ar.executed_at, ar.entity_type, n.to_address, n.channel, n.status AS notification_status, n.error
       FROM automation_runs ar LEFT JOIN notifications n ON n.id=ar.notification_id WHERE ar.rule_id=$1 AND ar.org_id=$2 ORDER BY ar.created_at DESC LIMIT 100`, [a.params.id, a.ctx.orgId])));
def("GET", "/notifications", "automations.manage", "Message log with delivery status", async (a) => {
  const q = a.query(z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }));
  return withOrg(a.ctx.orgId, async (db) => ({
    notifications: await db.query(`SELECT id, template_key, channel, to_address, status, provider, error, attempts, subject, created_at, sent_at, delivered_at FROM notifications WHERE org_id=$1 AND ($2::text IS NULL OR status=$2) AND ($4::uuid[] IS NULL OR location_id IS NULL OR location_id = ANY($4)) ORDER BY created_at DESC LIMIT $3`, [a.ctx.orgId, q.status ?? null, q.limit, a.ctx.locationIds]),
    counts: await db.one(`SELECT count(*) FILTER (WHERE status='simulated')::int AS simulated, count(*) FILTER (WHERE status='failed')::int AS failed, count(*) FILTER (WHERE status IN ('sent','delivered'))::int AS sent, count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='skipped')::int AS skipped FROM notifications WHERE org_id=$1`, [a.ctx.orgId]),
  }));
});
def("GET", "/templates", "automations.manage", "Message templates (defaults + overrides)", async (a) => withOrg(a.ctx.orgId, (db) => listTemplates(db, a.ctx)));
def("PUT", "/templates", "automations.manage", "Save a template override", async (a) => { const t = await a.body(templateSchema); await withOrg(a.ctx.orgId, (db) => saveTemplate(db, a.ctx, t)); return { ok: true }; });
def("POST", "/templates/preview", "automations.manage", "Render a template with sample data", async (a) => {
  const { body, subject } = await a.body(z.object({ body: z.string().max(2000), subject: z.string().max(200).nullable().optional() }));
  return previewTemplate(body, subject);
});
def("DELETE", "/templates", "automations.manage", "Reset a template to the default", async (a) => {
  const q = a.query(z.object({ key: z.string(), channel: z.string(), locale: z.string() }));
  await withOrg(a.ctx.orgId, (db) => resetTemplate(db, a.ctx, q.key, q.channel, q.locale));
  return { ok: true };
});
def("GET", "/integrations", "integrations.manage", "Integration status and configuration path", async () => ({ integrations: integrationOverview() }));
def("POST", "/integrations/:channel/test", "integrations.manage", "Send a test message to yourself (simulated when unconfigured)", async (a) => {
  const channel = channelSchema.parse(a.params.channel);
  const { to } = await a.body(z.object({ to: z.string().max(200).optional() }));
  return withOrg(a.ctx.orgId, (db) => sendTestMessage(db, a.ctx, channel, to));
});

// ───────────── Team, settings, audit, billing ─────────────
def("GET", "/team", "team.manage", "Members, invitations and the permission matrix", async (a) => withOrg(a.ctx.orgId, (db) => listTeam(db, a.ctx)));
def("POST", "/team/invitations", "team.manage", "Invite a member (role-limited)", async (a) => {
  const input = await a.body(inviteSchema);
  return json(await withOrg(a.ctx.orgId, (db) => inviteMember(db, a.ctx, input)), 201);
});
def("DELETE", "/team/invitations/:id", "team.manage", "Revoke an invitation", async (a) => { await withOrg(a.ctx.orgId, (db) => revokeInvitation(db, a.ctx, a.params.id)); return { ok: true }; });
def("PATCH", "/team/members/:id", "team.manage", "Change role / locations / status", async (a) => {
  const patch = await a.body(memberPatchSchema);
  await withOrg(a.ctx.orgId, (db) => updateMember(db, a.ctx, a.params.id, patch));
  return { ok: true };
});
def("DELETE", "/team/members/:id", "team.manage", "Remove a member", async (a) => { await withOrg(a.ctx.orgId, (db) => removeMember(db, a.ctx, a.params.id)); return { ok: true }; });

def("GET", "/organization", "settings.manage", "Organization profile", async (a) => withOrg(a.ctx.orgId, async (db) => ({
  organization: await db.one(`SELECT id, name, slug, locale, retention_months, status FROM organizations WHERE id=$1`, [a.ctx.orgId]),
})));
def("PATCH", "/organization", "settings.manage", "Update organization name / data-retention period", async (a) => {
  const patch = await a.body(z.object({ name: z.string().trim().min(2).max(100).optional(), retentionMonths: z.number().int().min(6).max(120).optional() }));
  await withOrg(a.ctx.orgId, async (db) => {
    await db.exec(`UPDATE organizations SET name=COALESCE($2,name), retention_months=COALESCE($3,retention_months) WHERE id=$1`, [a.ctx.orgId, patch.name ?? null, patch.retentionMonths ?? null]);
    await audit(db, a.ctx, "organization.update", "organization", a.ctx.orgId, patch);
  });
  return { ok: true };
});
def("GET", "/audit", "audit.view", "Audit log of administrative actions", async (a) => {
  const q = a.query(z.object({ before: z.coerce.number().int().optional(), action: z.string().max(50).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }));
  return withOrg(a.ctx.orgId, async (db) => ({ entries: await listAudit(db, a.ctx, q) }));
});
def("GET", "/billing", "billing.manage", "Plan, usage and billing provider status", async (a) => withOrg(a.ctx.orgId, (db) => getBilling(db, a.ctx)));
def("POST", "/billing/plan", "billing.manage", "Change plan (simulated unless a billing provider is connected)", async (a) => {
  const input = await a.body(changePlanSchema);
  return withOrg(a.ctx.orgId, (db) => changePlan(db, a.ctx, input));
});
def("GET", "/usage", null, "Plan usage vs limits", async (a) => withOrg(a.ctx.orgId, async (db) => ({ usage: await getUsage(db, a.ctx.orgId), plan: await getPlanInfo(db, a.ctx.orgId) })));

export { withSystem };
