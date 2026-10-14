export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  /** field -> message map for form validation errors (422) */
  get fields(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) for (const d of this.details as Array<{ path?: string; message?: string }>) if (d.path) out[d.path] = d.message ?? "Invalid";
    return out;
  }
}

export async function request<T = unknown>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, signal, credentials: "same-origin", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "Network error — check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/") && !url.startsWith("/api/public/")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, err?.code ?? "ERROR", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string, signal?: AbortSignal) => request<T>("GET", url, undefined, signal), // eslint-disable-line @typescript-eslint/no-explicit-any
  post: <T = any>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}), // eslint-disable-line @typescript-eslint/no-explicit-any
  put: <T = any>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}), // eslint-disable-line @typescript-eslint/no-explicit-any
  patch: <T = any>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}), // eslint-disable-line @typescript-eslint/no-explicit-any
  del: <T = any>(url: string) => request<T>("DELETE", url), // eslint-disable-line @typescript-eslint/no-explicit-any
};

export const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
