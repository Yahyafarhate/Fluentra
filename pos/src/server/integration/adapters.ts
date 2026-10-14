import { createHmac } from "node:crypto";
import { withOrg } from "@/lib/db";
import { env } from "@/lib/env";

export interface OutboundEvent {
  eventId: string; type: string; version: number; occurredAt: string; orgId: string;
  outlet: { id: string | null; fluentraLocationId: string | null }; data: Record<string, unknown>;
}
export interface IntegrationSettings { adapter: "none" | "mock" | "http"; baseUrl: string | null; shareSales: boolean; shareItems: boolean; shareRefunds: boolean; shareKitchen: boolean }
export interface PublishResult { ok: boolean; retryable?: boolean; error?: string }

export interface FluentraAdapter {
  id: "mock" | "http";
  /** Test adapters must never be presented as a live integration */
  isTest: boolean;
  label: string;
  publish(event: OutboundEvent, settings: IntegrationSettings): Promise<PublishResult>;
}

/** Wire envelope sent to Fluentra (spec version 1). */
export function envelope(e: OutboundEvent) {
  return { specVersion: 1, source: "comptoir-pos", eventId: e.eventId, type: e.type, version: e.version, occurredAt: e.occurredAt, organizationId: e.orgId, outlet: e.outlet, data: e.data };
}
export const sign = (secret: string, timestamp: string, body: string) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

let mockFailure = false;
/** Test hook: simulates Fluentra being down (every delivery fails with a retryable error). */
export const setMockFluentraDown = (down: boolean) => { mockFailure = down; };

/**
 * TEST ENVIRONMENT ONLY. Writes events into a local table (mock_fluentra_inbox) with an idempotent receiver.
 * It proves the POS side of the contract; it is NOT a live Fluentra integration.
 */
export const mockAdapter: FluentraAdapter = {
  id: "mock", isTest: true, label: "MOCK Fluentra (test environment — not a live integration)",
  async publish(event) {
    if (mockFailure) return { ok: false, retryable: true, error: "Mock Fluentra is down (simulated)" };
    await withOrg(event.orgId, (db) => db.exec(
      `INSERT INTO mock_fluentra_inbox (org_id, event_id, type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, event_id) DO NOTHING`,
      [event.orgId, event.eventId, event.type, JSON.stringify(envelope(event))]));
    return { ok: true };
  },
};

export function assertSafeBaseUrl(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("Invalid URL"); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && !env.isProd)) throw new Error("The Fluentra endpoint must use https");
  if (u.username || u.password) throw new Error("Credentials in the URL are not allowed");
  return u.toString();
}

/**
 * Signed HTTPS delivery. The endpoint is the full URL configured by the organization.
 * NOTE: Fluentra does not expose a POS ingestion endpoint yet — this adapter implements the POS side of the
 * documented contract (docs/FLUENTRA_INTEGRATION.md) and has not been verified against a live Fluentra.
 */
export const httpAdapter: FluentraAdapter = {
  id: "http", isTest: false, label: "Fluentra HTTPS endpoint (signed)",
  async publish(event, settings) {
    const secret = env.fluentraSecret;
    if (!settings.baseUrl) return { ok: false, retryable: false, error: "No Fluentra endpoint configured" };
    if (!secret) return { ok: false, retryable: false, error: "FLUENTRA_SHARED_SECRET is not set" };
    let url: string;
    try { url = assertSafeBaseUrl(settings.baseUrl); } catch (e) { return { ok: false, retryable: false, error: (e as Error).message }; }
    const body = JSON.stringify(envelope(event));
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-comptoir-event-id": event.eventId, "x-comptoir-timestamp": ts, "x-comptoir-signature": sign(secret, ts, body), "idempotency-key": event.eventId },
        body,
      });
      if (res.ok || res.status === 409) return { ok: true };            // 409 = receiver already has this event id
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, retryable, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, retryable: true, error: String((e as Error).message).slice(0, 200) };
    }
  },
};

let override: FluentraAdapter | null = null;
export const setAdapterOverride = (a: FluentraAdapter | null) => { override = a; };
export const adapterFor = (s: IntegrationSettings): FluentraAdapter | null => override ?? (s.adapter === "mock" ? mockAdapter : s.adapter === "http" ? httpAdapter : null);
