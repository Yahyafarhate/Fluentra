import { env } from "@/lib/env";
import { safeEqual } from "@/lib/ids";
import { errorResponse } from "@/lib/api";
import { purgeRateLimits } from "@/lib/ratelimit";
import { purgeOldEvents, runOutbox } from "@/server/integration/dispatcher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Scheduler entry point (outbox delivery + housekeeping): `Authorization: Bearer $CRON_SECRET`. GET for Vercel Cron, POST for others. */
async function handle(req: Request) {
  try {
    const secret = env.cronSecret;
    const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || !safeEqual(secret, given)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid cron secret" } }, { status: 401 });
    const outbox = await runOutbox(100);
    await purgeRateLimits();
    const purged = await purgeOldEvents();
    return Response.json({ outbox, purged });
  } catch (e) {
    return errorResponse(e);
  }
}
export const GET = handle;
export const POST = handle;
