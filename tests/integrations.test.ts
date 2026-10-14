import { describe, expect, it, afterEach } from "vitest";
import { createTenant, booking } from "./helpers";
import { createReservation, transitionReservation } from "@/server/reservations/service";
import { withOrg, withSystem } from "@/lib/db";
import { runDueJobs } from "@/server/notifications/jobs";
import { __setAdapterOverride, type MessageAdapter, channelStatus } from "@/server/notifications/adapters";
import { enqueueNotification, deliverNotification } from "@/server/notifications/service";
import { hmac } from "@/lib/ids";
import { POST as webhook } from "@/app/api/webhooks/delivery/route";
import { env } from "@/lib/env";
import { api, loginAs } from "./api";

afterEach(() => { __setAdapterOverride({}); process.env.DEV_SIMULATE_NOTIFICATIONS = "true"; });

const notifs = (orgId: string) => withOrg(orgId, (db) => db.query<{ id: string; status: string; error: string | null; attempts: number; channel: string; provider: string | null }>(`SELECT id, status, error, attempts, channel, provider FROM notifications ORDER BY created_at`));

describe("notifications & integration failure handling", () => {
  it("records SIMULATED (never 'sent') when no provider is connected in dev mode", async () => {
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev" }));
    await runDueJobs(50);
    const n = await notifs(t.orgId);
    expect(n).toHaveLength(1);
    expect(n[0].status).toBe("simulated");
    expect(channelStatus("email").state).toBe("simulated");
  });

  it("marks messages as skipped (not delivered) when simulation is off and no provider exists", async () => {
    process.env.DEV_SIMULATE_NOTIFICATIONS = "false";
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev" }));
    await runDueJobs(50);
    const n = await notifs(t.orgId);
    expect(n[0].status).toBe("skipped");
    expect(n[0].error).toMatch(/No provider/);
    expect(channelStatus("email").state).toBe("not_configured");
  });

  it("retries retryable provider failures with backoff, then fails permanently with the error recorded", async () => {
    let calls = 0;
    const flaky: MessageAdapter = { channel: "email", provider: "flaky", isConfigured: () => true, send: async () => { calls++; return { ok: false, error: "connect ECONNREFUSED", retryable: true }; } };
    __setAdapterOverride({ email: flaky });
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev" }));
    await runDueJobs(50);
    let n = (await notifs(t.orgId))[0];
    expect(n.status).toBe("queued"); expect(n.attempts).toBe(1);
    // fast-forward the retry schedule
    for (let i = 0; i < 4; i++) { await withSystem((db) => db.exec(`UPDATE jobs SET run_at=now() WHERE status='queued'`)); await runDueJobs(50); }
    n = (await notifs(t.orgId))[0];
    expect(n.status).toBe("failed");
    expect(n.error).toContain("ECONNREFUSED");
    expect(calls).toBe(3); // rule max_attempts = 3
    const runs = await withOrg(t.orgId, (db) => db.query<{ status: string; detail: string }>(`SELECT status, detail FROM automation_runs WHERE notification_id IS NOT NULL`));
    expect(runs[0].status).toBe("failed");
  });

  it("does not retry permanent failures", async () => {
    let calls = 0;
    __setAdapterOverride({ email: { channel: "email", provider: "p", isConfigured: () => true, send: async () => { calls++; return { ok: false, error: "550 mailbox unknown", retryable: false }; } } });
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev" }));
    await runDueJobs(50);
    expect((await notifs(t.orgId))[0].status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("a real SMTP adapter pointed at a dead host fails gracefully and is reported as failed", async () => {
    process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = "1";
    try {
      const t = await createTenant();
      await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev" }));
      await runDueJobs(50);
      for (let i = 0; i < 4; i++) { await withSystem((db) => db.exec(`UPDATE jobs SET run_at=now() WHERE status='queued'`)); await runDueJobs(50); }
      const n = (await notifs(t.orgId))[0];
      expect(n.status).toBe("failed");
      expect(n.error).toMatch(/ECONNREFUSED|connect/i);
    } finally { delete process.env.SMTP_HOST; delete process.env.SMTP_PORT; }
  });

  it("is idempotent: duplicate enqueue and duplicate delivery never send twice", async () => {
    let calls = 0;
    __setAdapterOverride({ email: { channel: "email", provider: "p", isConfigured: () => true, send: async () => { calls++; return { ok: true, providerMessageId: "m1" }; } } });
    const t = await createTenant();
    const mk = () => withOrg(t.orgId, (db) => enqueueNotification(db, { orgId: t.orgId, templateKey: "booking_confirmation", channel: "email", to: "a@b.dev", locale: "fr", subject: "s", body: "b", idempotencyKey: "same-key" }));
    const first = await mk(); const second = await mk();
    expect(first).toBeTruthy(); expect(second).toBeNull();
    await Promise.all([deliverNotification(t.orgId, first!), deliverNotification(t.orgId, first!), deliverNotification(t.orgId, first!)]);
    expect(calls).toBe(1);
    expect((await notifs(t.orgId))[0].status).toBe("sent");
  });

  it("automation events are idempotent per reservation + version (no duplicate confirmations)", async () => {
    const t = await createTenant();
    const r = await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev", status: "pending" }));
    await transitionReservation(t.owner, r.id, { action: "confirm" });
    const n1 = (await notifs(t.orgId)).length;
    expect(n1).toBe(2); // "request received" (pending) + "confirmed"
    await runDueJobs(50);
    expect((await notifs(t.orgId)).every((n) => n.status === "simulated")).toBe(true);
  });

  it("never messages without consent for marketing-type templates, and honours withdrawn consent", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, undefined, "30.0.0.1");
    const r = await createReservation(t.owner, booking(t, { guestEmail: "a@b.dev", consent: { email: false } }));
    await withOrg(t.orgId, (db) => db.exec(`UPDATE automation_rules SET enabled=true WHERE trigger='visit_completed'`));
    await transitionReservation(t.owner, r.id, { action: "arrive" });
    const { seatWalkIn } = await import("@/server/reservations/service");
    void seatWalkIn;
    await transitionReservation(t.owner, r.id, { action: "seat", tableIds: undefined });
    await transitionReservation(t.owner, r.id, { action: "complete" });
    await withSystem((db) => db.exec(`UPDATE reservations SET completed_at = now() - interval '5 hours' WHERE id=$1`, [r.id]));
    const { runScheduledAutomations } = await import("@/server/automation/service");
    await runScheduledAutomations(); await runDueJobs(50);
    expect((await notifs(t.orgId)).filter((n) => n.status === "simulated").length).toBe(1); // only the transactional confirmation
    const runs = await api.v1("GET", `/automations`, { cookie });
    const rule = runs.json.rules.find((x: { trigger: string }) => x.trigger === "visit_completed");
    const hist = await api.v1("GET", `/automations/${rule.id}/runs`, { cookie });
    expect(hist.json[0].status).toBe("skipped");
    expect(hist.json[0].detail).toMatch(/consent/i);
  });

  it("webhooks require a valid HMAC signature and only they can mark delivery/engagement", async () => {
    process.env.WEBHOOK_SECRET = "whsec_test_secret";
    try {
      const t = await createTenant();
      await withOrg(t.orgId, (db) => db.exec(`INSERT INTO notifications (org_id, template_key, channel, to_address, body, status, provider, provider_message_id, idempotency_key) VALUES ($1,'campaign','email','a@b.dev','x','sent','smtp','msg-1','k1')`, [t.orgId]));
      const body = JSON.stringify({ provider: "smtp", providerMessageId: "msg-1", event: "delivered" });
      const bad = await webhook(new Request("http://localhost/api/webhooks/delivery", { method: "POST", body, headers: { "x-signature": "deadbeef" } }));
      expect(bad.status).toBe(401);
      expect((await notifs(t.orgId))[0].status).toBe("sent");
      const good = await webhook(new Request("http://localhost/api/webhooks/delivery", { method: "POST", body, headers: { "x-signature": hmac("whsec_test_secret", body) } }));
      expect(good.status).toBe(200);
      expect((await notifs(t.orgId))[0].status).toBe("delivered");
      expect(env.webhookSecret).toBe("whsec_test_secret");
    } finally { delete process.env.WEBHOOK_SECRET; }
    const unconfigured = await webhook(new Request("http://localhost/api/webhooks/delivery", { method: "POST", body: "{}" }));
    expect(unconfigured.status).toBe(503);
  });

  it("integration overview is honest about unconfigured providers", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, undefined, "30.1.0.1");
    const r = await api.v1("GET", "/integrations", { cookie });
    const byKind = Object.fromEntries(r.json.integrations.map((i: { kind: string }) => [i.kind, i]));
    expect(byKind.email.state).toBe("simulated");
    expect(byKind.payments.state).toBe("not_configured");
    expect(byKind.pos.state).toBe("not_configured");
    const test = await api.v1("POST", "/integrations/sms/test", { cookie, body: { to: "+212600000000" } });
    expect(test.json.ok).toBe(false);
    expect(test.json.message).toMatch(/nothing was sent/i);
  });
});
