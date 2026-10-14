import { env } from "@/lib/env";
import { safeEqual } from "@/lib/ids";
import { errorResponse } from "@/lib/api";
import { scheduleTick } from "@/server/automation/service";
import { runDueJobs } from "@/server/notifications/jobs";

export const dynamic = "force-dynamic";

/** Scheduler entry point: `Authorization: Bearer $CRON_SECRET`. POST for generic schedulers; GET is what Vercel Cron sends. */
export const GET = handle;
export const POST = handle;
export const maxDuration = 60;

async function handle(req: Request) {
  try {
    const secret = env.cronSecret;
    const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || !safeEqual(secret, given)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid cron secret" } }, { status: 401 });
    await scheduleTick();
    return Response.json(await runDueJobs(50));
  } catch (e) {
    return errorResponse(e);
  }
}
