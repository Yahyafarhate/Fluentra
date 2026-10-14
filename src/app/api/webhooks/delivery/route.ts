import { z } from "zod";
import { env } from "@/lib/env";
import { hmac, safeEqual } from "@/lib/ids";
import { errorResponse } from "@/lib/api";
import { applyDeliveryEvent } from "@/server/notifications/service";
import { rateLimit, clientIp } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const schema = z.object({ provider: z.string().max(40), providerMessageId: z.string().max(200), event: z.enum(["delivered", "failed", "opened", "clicked"]), error: z.string().max(300).optional() });

/**
 * Provider delivery / engagement callbacks. Authenticated by an HMAC-SHA256 signature of the raw body
 * (header `x-signature`, hex) using WEBHOOK_SECRET. Unsigned or badly signed requests are rejected.
 */
export async function POST(req: Request) {
  try {
    await rateLimit(`webhook:${clientIp(req)}`, 600, 60);
    const secret = env.webhookSecret;
    if (!secret) return Response.json({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "WEBHOOK_SECRET is not set" } }, { status: 503 });
    const raw = await req.text();
    if (raw.length > 20_000) return Response.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, { status: 413 });
    const sig = req.headers.get("x-signature") ?? "";
    if (!safeEqual(hmac(secret, raw), sig)) return Response.json({ error: { code: "INVALID_SIGNATURE", message: "Signature mismatch" } }, { status: 401 });
    await applyDeliveryEvent(schema.parse(JSON.parse(raw)));
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
