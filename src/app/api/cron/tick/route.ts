import { env } from "@/lib/env";
import { safeEqual } from "@/lib/ids";
import { errorResponse } from "@/lib/api";
import { scheduleTick } from "@/server/automation/service";
import { runDueJobs } from "@/server/notifications/jobs";

export const dynamic = "force-dynamic";

/** Scheduler entry point: POST with `Authorization: Bearer $CRON_SECRET` every minute (cron, k8s CronJob, Vercel cron…). */
export async function POST(req: Request) {
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
