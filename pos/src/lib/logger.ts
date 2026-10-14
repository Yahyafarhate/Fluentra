const REDACT = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|hash/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? "[redacted]" : /^(email|phone|guest_?(email|phone)|to_?address)$/i.test(k) ? "[pii]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: string, msg: string, data?: Record<string, unknown>) {
  if (process.env.VITEST && level !== "error") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ? (scrub(data) as object) : {}) });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
