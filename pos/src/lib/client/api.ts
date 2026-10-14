"use client";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const newKey = (prefix = "op") => `${prefix}-${rid()}`;

export interface CallOpts { idempotencyKey?: string | null; signal?: AbortSignal }

/** Thin fetch wrapper. Mutations may carry an Idempotency-Key so a retry can never duplicate an operation. */
export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "Network unavailable");
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) { if (!res.ok) throw new ApiError(res.status, "HTTP_ERROR", `HTTP ${res.status}`); return (await res.text()) as unknown as T; }
  const data = await res.json();
  if (!res.ok && !(data && typeof data === "object" && "payment" in data && "order" in data)) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } }).error;
    if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.includes("login")) {
      window.location.href = window.location.pathname.startsWith("/admin") ? "/admin/login" : "/pos/login";
    }
    throw new ApiError(res.status, err?.code ?? "ERROR", err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return data as T;
}

export async function authCall<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try { res = await fetch(`/api/auth${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" }); }
  catch { throw new ApiError(0, "NETWORK", "Network unavailable"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? `HTTP ${res.status}`, data?.error?.details);
  return data as T;
}
