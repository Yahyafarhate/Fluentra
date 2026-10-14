import type { Router } from "@/server/http/router";
import { authRouter } from "@/server/routes/auth";
import { v1 } from "@/server/routes/v1";
import { publicRouter } from "@/server/routes/public";
import { adminRouter } from "@/server/routes/admin";
import { PASSWORD } from "./helpers";

const ORIGIN = "http://localhost:3000";
export interface CallOpts { cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string>; ip?: string }
export interface Res { status: number; json: any; headers: Headers; text: string }  

export async function call(router: Router, method: string, path: string, o: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ip) headers["x-real-ip"] = o.ip;
  const req = new Request(ORIGIN + path, { method, headers, body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body) });
  const prefix = router.prefix;
  const segs = path.split("?")[0].slice(prefix.length).split("/").filter(Boolean);
  const res = await router.handler(req, { params: Promise.resolve({ path: segs }) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}

export const api = {
  v1: (m: string, p: string, o?: CallOpts) => call(v1, m, "/api/v1" + p, o),
  auth: (m: string, p: string, o?: CallOpts) => call(authRouter, m, "/api/auth" + p, o),
  pub: (m: string, p: string, o?: CallOpts) => call(publicRouter, m, "/api/public" + p, o),
  admin: (m: string, p: string, o?: CallOpts) => call(adminRouter, m, "/api/admin" + p, o),
};

export async function loginAs(email: string, password = PASSWORD, ip = "10.0.0.1"): Promise<string> {
  const r = await api.auth("POST", "/login", { body: { email, password }, ip });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.text}`);
  const set = r.headers.get("set-cookie")!;
  return set.split(";")[0];
}
