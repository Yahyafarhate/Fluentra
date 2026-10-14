import { withSystem } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await withSystem((db) => db.one("SELECT 1 AS ok"));
    return Response.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
