import { errorResponse } from "@/lib/api";
import { isUuid } from "@/lib/ids";
import { readPublicFile } from "@/server/tenants/uploads";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isUuid(id)) throw notFound("File");
    const f = await readPublicFile(id);
    return new Response(new Uint8Array(f.data), {
      headers: { "Content-Type": f.contentType, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
