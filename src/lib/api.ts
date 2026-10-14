import { ZodError, type ZodType } from "zod";
import { AppError, badRequest, forbidden, unauthorized } from "./errors";
import { assertPermission, getCtx, getSessionUser, parseCookies, requireSuper, SESSION_COOKIE, type Ctx, type SuperCtx } from "./auth";
import type { Permission } from "./rbac";
import { rateLimit, clientIp } from "./ratelimit";
import { log } from "./logger";
import { env } from "./env";

type Params = Record<string, string>;
type RouteArgs = { params: Promise<Params> };

export interface ApiInput<C> {
  req: Request;
  ctx: C;
  params: Params;
  url: URL;
  ip: string;
  body: <T>(schema: ZodType<T>) => Promise<T>;
  query: <T>(schema: ZodType<T>) => T;
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) {
    const headers: Record<string, string> = {};
    if (e.code === "RATE_LIMITED" && e.details && typeof e.details === "object") headers["Retry-After"] = String((e.details as { retryAfterSec: number }).retryAfterSec);
    return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status, headers);
  }
  if (e instanceof ZodError) {
    return json({ error: { code: "VALIDATION_ERROR", message: "Invalid input", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 422);
  }
  const pg = e as { code?: string; constraint?: string };
  if (pg?.code === "23P01") return json({ error: { code: "TABLE_CONFLICT", message: "That table is already booked for an overlapping time." } }, 409);
  if (pg?.code === "23505") return json({ error: { code: "DUPLICATE", message: "A record with the same unique value already exists.", details: { constraint: pg.constraint } } }, 409);
  if (pg?.code === "23503") return json({ error: { code: "INVALID_REFERENCE", message: "Referenced record does not exist or belongs to another account." } }, 422);
  if (pg?.code === "22P02") return json({ error: { code: "BAD_REQUEST", message: "Malformed identifier." } }, 400);
  log.error("unhandled error", { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : undefined });
  return json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
}

/** CSRF defense for cookie-authenticated mutations: Origin (or Referer) must match this app / the request host. */
function assertSameOrigin(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (env.isTest && !req.headers.get("origin")) return;
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  if (!origin) throw forbidden("Missing Origin header", "CSRF");
  const host = req.headers.get("host");
  const allowed = new Set([env.appUrl]);
  if (host) { allowed.add(`http://${host}`); allowed.add(`https://${host}`); }
  if (!allowed.has(origin)) throw forbidden("Cross-origin request blocked", "CSRF");
}

async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const text = await req.text();
  if (text.length > 1_000_000) throw badRequest("Payload too large", "PAYLOAD_TOO_LARGE");
  let raw: unknown = {};
  if (text) {
    try { raw = JSON.parse(text); } catch { throw badRequest("Body must be valid JSON", "INVALID_JSON"); }
  }
  return schema.parse(raw);
}

function inputFor<C>(req: Request, ctx: C, params: Params): ApiInput<C> {
  const url = new URL(req.url);
  return {
    req, ctx, params, url, ip: clientIp(req),
    body: (schema) => readBody(req, schema),
    query: (schema) => schema.parse(Object.fromEntries(url.searchParams)),
  };
}

function wrap<C>(resolve: (req: Request) => Promise<C>, handler: (a: ApiInput<C>) => Promise<unknown>, pre?: (a: ApiInput<C>) => Promise<void>) {
  return async (req: Request, route: RouteArgs): Promise<Response> => {
    try {
      const ctx = await resolve(req);
      const input = inputFor(req, ctx, (await route.params) ?? {});
      if (pre) await pre(input);
      const out = await handler(input);
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

const tokenOf = (req: Request) => parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];

/** Authenticated tenant route with server-side permission check + CSRF origin check. */
export function authed(perm: Permission | Permission[] | null, handler: (a: ApiInput<Ctx>) => Promise<unknown>, opts: { rate?: { limit: number; windowSec: number; key: string } } = {}) {
  return wrap<Ctx>(
    async (req) => {
      assertSameOrigin(req);
      const ctx = await getCtx(tokenOf(req));
      if (!ctx) throw unauthorized();
      if (perm) assertPermission(ctx, perm);
      else if (ctx.org.status === "suspended" || ctx.org.status === "cancelled") throw forbidden("This account is suspended. Please contact support.", "ORG_SUSPENDED");
      return ctx;
    },
    handler,
    opts.rate ? async (a) => rateLimit(`${opts.rate!.key}:${a.ctx.user.id}`, opts.rate!.limit, opts.rate!.windowSec) : undefined,
  );
}

/** Platform super-admin route. */
export function superAdmin(handler: (a: ApiInput<SuperCtx>) => Promise<unknown>) {
  return wrap<SuperCtx>(async (req) => {
    assertSameOrigin(req);
    return requireSuper(await getSessionUser(tokenOf(req)));
  }, handler);
}

/** Session without tenant membership (e.g. /me, org switch). */
export function sessionOnly(handler: (a: ApiInput<SuperCtx>) => Promise<unknown>) {
  return wrap<SuperCtx>(async (req) => {
    assertSameOrigin(req);
    const s = await getSessionUser(tokenOf(req));
    if (!s) throw unauthorized();
    return s;
  }, handler);
}

/** Unauthenticated route (public booking, login...). Always rate-limited per client IP. */
export function publicRoute(
  opts: { rate: { key: string; limit: number; windowSec: number }; csrf?: boolean },
  handler: (a: ApiInput<null>) => Promise<unknown>,
) {
  return wrap<null>(
    async (req) => { if (opts.csrf !== false) assertSameOrigin(req); return null; },
    handler,
    async (a) => rateLimit(`${opts.rate.key}:${a.ip}`, opts.rate.limit, opts.rate.windowSec),
  );
}
