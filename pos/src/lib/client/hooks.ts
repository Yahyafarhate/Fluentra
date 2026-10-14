"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try { const d = await api<T>("GET", path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError(e as ApiError); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { setLoading(!!path); load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: load, setData };
}

/** Live updates via SSE with polling fallback. Calls `onChange` (debounced) on any change. Returns the connection mode. */
export function useLive(outletId: string | null, onChange: () => void, pollMs = 5000) {
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; });
  const [mode, setMode] = useState<"live" | "polling">("polling");
  useEffect(() => {
    if (!outletId) return;
    let es: EventSource | null = null; let t: ReturnType<typeof setTimeout> | null = null; let poll: ReturnType<typeof setInterval> | null = null;
    const fire = () => { if (t) clearTimeout(t); t = setTimeout(() => cb.current(), 200); };
    const startPoll = () => { if (!poll) poll = setInterval(() => { if (document.visibilityState === "visible") cb.current(); }, pollMs); };
    if (typeof EventSource !== "undefined") {
      es = new EventSource(`/api/v1/stream?outletId=${outletId}`);
      es.addEventListener("ready", () => setMode("live"));
      es.addEventListener("change", fire);
      es.onerror = () => { setMode("polling"); startPoll(); };
    } else startPoll();
    startPoll();
    return () => { es?.close(); if (t) clearTimeout(t); if (poll) clearInterval(poll); };
  }, [outletId, pollMs]);
  return mode;
}

export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const up = () => setOnline(true); const down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return now;
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => { try { const s = localStorage.getItem(key); if (s !== null) setV(JSON.parse(s)); } catch { /* unavailable */ } }, [key]);
  const set = useCallback((n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* ignore */ } }, [key]);
  return [v, set];
}
