"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

export interface ApiState<T> { data: T | null; error: ApiError | null; loading: boolean; refreshing: boolean; reload: () => Promise<void>; setData: (d: T | null) => void }

/** GET hook with cancellation, stale-while-revalidate and manual reload. Pass null to skip. */
export function useApi<T = any>(url: string | null): ApiState<T> {  
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [refreshing, setRefreshing] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const load = useCallback(async (initial: boolean) => {
    if (!url) { setLoading(false); return; }
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    const my = ++seq.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try {
      const d = await api.get<T>(url, c.signal);
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (my === seq.current) setError(e as ApiError);
    } finally {
      if (my === seq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [url]);
  useEffect(() => { setData(null); load(true); return () => ctl.current?.abort(); }, [load]);
  const reload = useCallback(() => load(false), [load]);
  return { data, error, loading, refreshing, reload, setData };
}

/**
 * Live updates: Server-Sent Events fed by PostgreSQL LISTEN/NOTIFY, with a polling fallback
 * (every `pollMs`) if the stream is unavailable. Calls `onChange` (debounced) on any change event.
 */
export function useLive(locationId: string | null, onChange: () => void, pollMs = 30000) {
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; });
  const [mode, setMode] = useState<"live" | "polling">("polling");
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const fire = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => cb.current(), 250); };
    const startPoll = () => { if (!poll) poll = setInterval(() => { if (document.visibilityState === "visible") cb.current(); }, pollMs); };
    if (typeof EventSource !== "undefined" && locationId) {
      es = new EventSource(`/api/v1/stream?locationId=${locationId}`);
      es.addEventListener("ready", () => setMode("live"));
      es.addEventListener("change", fire);
      es.onerror = () => { setMode("polling"); startPoll(); };
    } else startPoll();
    startPoll(); // cheap safety net even when live: low-frequency refresh
    return () => { es?.close(); if (timer) clearTimeout(timer); if (poll) clearInterval(poll); };
  }, [locationId, pollMs]);
  return mode;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => { try { const s = localStorage.getItem(key); if (s !== null) setV(JSON.parse(s)); } catch { /* storage unavailable */ } }, [key]);
  const set = useCallback((n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* ignore */ } }, [key]);
  return [v, set];
}
