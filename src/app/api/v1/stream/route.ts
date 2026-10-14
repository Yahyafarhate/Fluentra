import { Client } from "pg";
import { env } from "@/lib/env";
import { getCtx, parseCookies, SESSION_COOKIE, assertLocationAccess, assertPermission } from "@/lib/auth";
import { errorResponse } from "@/lib/api";
import { unauthorized } from "@/lib/errors";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events: pushes `change` events (reservation / floor / waitlist / settings) for one location,
 * fed by PostgreSQL LISTEN/NOTIFY. Clients fall back to polling if the stream drops.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getCtx(parseCookies(req.headers.get("cookie"))[SESSION_COOKIE]);
    if (!ctx) throw unauthorized();
    assertPermission(ctx, "dashboard.view");
    const locationId = new URL(req.url).searchParams.get("locationId");
    if (locationId && !isUuid(locationId)) throw unauthorized();
    if (locationId) assertLocationAccess(ctx, locationId);

    const client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
    await client.query("LISTEN fl_changes");
    const enc = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = (s: string) => { if (!closed) try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
        send(`retry: 3000\nevent: ready\ndata: {}\n\n`);
        client.on("notification", (m) => {
          try {
            const p = JSON.parse(m.payload ?? "{}") as { orgId: string; locationId: string | null; kind: string };
            if (p.orgId !== ctx.orgId) return; // tenant isolation: never forward another org's events
            if (locationId && p.locationId && p.locationId !== locationId) return;
            if (ctx.locationIds && p.locationId && !ctx.locationIds.includes(p.locationId)) return;
            send(`event: change\ndata: ${JSON.stringify({ kind: p.kind, locationId: p.locationId })}\n\n`);
          } catch { /* ignore malformed payloads */ }
        });
        const ping = setInterval(() => send(`: ping\n\n`), 25_000);
        const close = () => { if (closed) return; closed = true; clearInterval(ping); client.end().catch(() => undefined); try { controller.close(); } catch { /* */ } };
        req.signal.addEventListener("abort", close);
        client.on("error", close);
      },
      cancel() { closed = true; client.end().catch(() => undefined); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (e) {
    return errorResponse(e);
  }
}
