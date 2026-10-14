import { Client } from "pg";
import { env } from "@/lib/env";
import { getCtx, parseCookies, SESSION_COOKIE, assertOutletAccess, assertPermission } from "@/lib/auth";
import { errorResponse } from "@/lib/api";
import { unauthorized } from "@/lib/errors";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events: `change` events (order / kitchen / cash) for one outlet, fed by PostgreSQL LISTEN/NOTIFY.
 * Clients fall back to polling when the stream is unavailable (serverless hosts return 503).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getCtx(parseCookies(req.headers.get("cookie"))[SESSION_COOKIE]);
    if (!ctx) throw unauthorized();
    assertPermission(ctx, "pos.access");
    if (env.serverless) return Response.json({ error: { code: "STREAM_UNAVAILABLE", message: "Live stream is not available on this host; polling is used." } }, { status: 503 });
    const outletId = new URL(req.url).searchParams.get("outletId");
    if (!outletId || !isUuid(outletId)) throw unauthorized();
    assertOutletAccess(ctx, outletId);

    const client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
    await client.query("LISTEN pos_changes");
    const enc = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = (s: string) => { if (!closed) try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
        send(`retry: 3000\nevent: ready\ndata: {}\n\n`);
        client.on("notification", (m) => {
          try {
            const p = JSON.parse(m.payload ?? "{}") as { orgId: string; outletId: string | null; kind: string };
            if (p.orgId !== ctx.orgId) return; // tenant isolation: never forward another org's events
            if (p.outletId && p.outletId !== outletId) return;
            send(`event: change\ndata: ${JSON.stringify({ kind: p.kind })}\n\n`);
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
