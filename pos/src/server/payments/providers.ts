import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";

export interface ChargeRequest { amountCents: number; tipCents: number; currency: string; reference: string; idempotencyKey: string; scenario?: "approve" | "decline" | "pending" }
export interface ChargeResult { status: "succeeded" | "declined" | "pending"; providerRef?: string; declineReason?: string }
export interface RefundRequest { amountCents: number; currency: string; paymentProviderRef: string | null; idempotencyKey: string }
export interface RefundResult { status: "succeeded" | "failed" | "pending"; providerRef?: string; error?: string }

/**
 * Card payment provider contract. A payment may only be marked successful when `charge` returns "succeeded"
 * (i.e. the provider/terminal confirmed it). Real adapters (CMI, Stripe Terminal, ...) are NOT implemented yet.
 */
export interface PaymentProvider {
  id: string;
  /** Human label; test providers must say TEST */
  label: string;
  isTest: boolean;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
}

/** DEVELOPMENT / TEST ONLY. Simulates a card terminal; never talks to a bank. Disabled when POS_ENABLE_TEST_PAYMENTS is off. */
export const testTerminal: PaymentProvider = {
  id: "test_terminal",
  label: "TEST card terminal (simulated — no real money)",
  isTest: true,
  async charge(req) {
    if (req.scenario === "decline") return { status: "declined", declineReason: "Card declined (test scenario)" };
    if (req.scenario === "pending") return { status: "pending", providerRef: `test_${randomUUID().slice(0, 12)}` };
    return { status: "succeeded", providerRef: `test_${randomUUID().slice(0, 12)}` };
  },
  async refund() { return { status: "succeeded", providerRef: `test_rf_${randomUUID().slice(0, 12)}` }; },
};

let override: PaymentProvider | null = null;
/** tests can inject a provider */
export const setPaymentProviderOverride = (p: PaymentProvider | null) => { override = p; };

export function cardProvider(): PaymentProvider | null {
  if (override) return override;
  return env.testPayments ? testTerminal : null;
}
