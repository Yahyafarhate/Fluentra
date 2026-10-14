import { withSystem } from "@/lib/db";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await withSystem((db) => db.one("SELECT 1 AS ok"));
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
