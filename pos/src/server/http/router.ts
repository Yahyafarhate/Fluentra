import { errorResponse, json } from "@/lib/api";

type RouteFn = (req: Request, route: { params: Promise<Record<string, string>> }) => Promise<Response>;
export interface RouteDoc { method: string; path: string; access: string; summary: string }
interface Entry { method: string; segments: string[]; fn: RouteFn; doc: RouteDoc }

/** Declarative route table: one place defines method, path, required permission and handler. */
export class Router {
  private entries: Entry[] = [];
  constructor(public readonly prefix: string) {}

  add(method: string, path: string, access: string, summary: string, fn: RouteFn) {
    this.entries.push({ method, segments: path.split("/").filter(Boolean), fn, doc: { method, path: this.prefix + path, access, summary } });
  }

  get docs(): RouteDoc[] { return this.entries.map((e) => e.doc); }

  handler = async (req: Request, route: { params: Promise<{ path?: string[] }> }): Promise<Response> => {
    try {
      const segs = (await route.params).path ?? [];
      let pathMatched = false;
      for (const e of this.entries) {
        if (e.segments.length !== segs.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < segs.length; i++) {
          const p = e.segments[i];
          if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]);
          else if (p !== segs[i]) { ok = false; break; }
        }
        if (!ok) continue;
        pathMatched = true;
        if (e.method !== req.method) continue;
        return await e.fn(req, { params: Promise.resolve(params) });
      }
      if (pathMatched) return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, 405);
      return json({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
