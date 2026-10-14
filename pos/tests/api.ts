import type { Router } from "@/server/http/router";

const ORIGIN = "http://localhost:3100";
export interface CallOpts { cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string>; ip?: string }
export interface Res { status: number; json: any; headers: Headers; text: string }

export async function call(router: Router, method: string, path: string, o: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ip) headers["x-real-ip"] = o.ip;
  const req = new Request(ORIGIN + path, { method, headers, body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body) });
  const segs = path.split("?")[0].slice(router.prefix.length).split("/").filter(Boolean);
  const res = await router.handler(req, { params: Promise.resolve({ path: segs }) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}
