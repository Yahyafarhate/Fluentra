"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, Field, Input, Logo, LangSwitch, Notice } from "@/components/ui";
import { authCall, ApiError } from "@/lib/client/api";
import { useLocalState } from "@/lib/client/hooks";
import { useT } from "@/lib/i18n";

interface Staff { id: string; name: string; role: string }

function Login() {
  const t = useT();
  const kds = useSearchParams().get("kds") === "1";
  const [code, setCode] = useLocalState<string>("cp_terminal_code", "");
  const [draft, setDraft] = useState("");
  const [outlet, setOutlet] = useState<{ id: string; name: string } | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [who, setWho] = useState<Staff | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStaff = useCallback(async (c: string) => {
    setErr(null);
    try { const r = await authCall<{ outlet: { id: string; name: string }; staff: Staff[] }>("GET", `/staff?code=${encodeURIComponent(c)}`); setOutlet(r.outlet); setStaff(r.staff); }
    catch (e) { setOutlet(null); setErr((e as ApiError).message); }
  }, []);
  useEffect(() => { if (code) loadStaff(code); }, [code, loadStaff]);

  const submit = useCallback(async (p: string) => {
    if (!who) return; setBusy(true); setErr(null);
    try {
      await authCall("POST", "/pin-login", { outletCode: code, employeeId: who.id, pin: p });
      window.location.href = kds || who.role === "kitchen" ? "/kds" : "/pos";
    } catch (e) { setErr((e as ApiError).message); setPin(""); setBusy(false); }
  }, [who, code, kds]);

  const press = (d: string) => { if (busy) return; const n = (pin + d).slice(0, 8); setPin(n); if (n.length >= 4 && d === "ok") return; };
  useEffect(() => {
    if (!who) return;
    const onKey = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 8)); else if (e.key === "Backspace") setPin((p) => p.slice(0, -1)); else if (e.key === "Enter") submit(pin); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [who, pin, submit]);

  return (
    <main className="min-h-dvh bg-charcoal text-white grid place-items-center p-4">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-between mb-6 text-white"><Logo /><LangSwitch /></div>
        {!outlet ? (
          <Card className="text-ink">
            <h1 className="text-xl font-semibold mb-1">{t("Terminal code")}</h1>
            <p className="text-sm text-ink-2 mb-4">{t("Enter the code of your outlet (shown in the back office). It is remembered on this device.")}</p>
            <form onSubmit={(e) => { e.preventDefault(); setCode(draft.trim().toUpperCase()); }} className="grid gap-3">
              <Field label={t("Code")}><Input value={draft} onChange={(e) => setDraft(e.target.value.toUpperCase())} className="text-center text-2xl tracking-[.3em] font-mono h-14" maxLength={10} autoFocus /></Field>
              {err && <Notice tone="bad">{err}</Notice>}
              <Button type="submit" size="lg" disabled={draft.length < 4}>{t("Continue")}</Button>
            </form>
          </Card>
        ) : !who ? (
          <div>
            <div className="flex items-baseline justify-between mb-3"><h1 className="text-2xl font-semibold">{outlet.name}</h1><button className="text-sm text-white/60 underline" onClick={() => { setOutlet(null); setCode(""); setDraft(""); }}>{t("Change terminal")}</button></div>
            <p className="text-white/70 mb-4">{t("Who is signing in?")}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {staff.map((s) => (
                <button key={s.id} onClick={() => { setWho(s); setPin(""); setErr(null); }} className="rounded-2xl bg-charcoal-2 hover:bg-charcoal-3 border border-white/10 p-4 text-left min-h-24">
                  <div className="size-10 rounded-full bg-gold text-charcoal font-semibold grid place-items-center">{s.name.slice(0, 1).toUpperCase()}</div>
                  <div className="mt-2 font-medium truncate">{s.name}</div><div className="text-xs text-white/50">{t(s.role)}</div>
                </button>
              ))}
              {staff.length === 0 && <p className="col-span-full text-white/60">{t("No employee has a PIN yet. Add one in the back office.")}</p>}
            </div>
          </div>
        ) : (
          <div className="max-w-xs mx-auto">
            <button className="text-sm text-white/60 underline mb-2" onClick={() => { setWho(null); setPin(""); setErr(null); }}>← {t("Back")}</button>
            <h1 className="text-xl font-semibold">{who.name}</h1>
            <div className="flex justify-center gap-3 my-6" aria-label={t("PIN")}>{Array.from({ length: Math.max(4, pin.length) }).map((_, i) => <span key={i} className={`size-4 rounded-full ${i < pin.length ? "bg-gold" : "bg-white/20"}`} />)}</div>
            {err && <div className="mb-3"><Notice tone="bad">{err}</Notice></div>}
            <div className="grid grid-cols-3 gap-3">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} onClick={() => press(d)} className="h-16 rounded-2xl bg-charcoal-2 hover:bg-charcoal-3 text-2xl font-medium active:scale-95">{d}</button>)}
              <button onClick={() => setPin("")} className="h-16 rounded-2xl text-white/60 hover:bg-charcoal-2">{t("Clear")}</button>
              <button onClick={() => press("0")} className="h-16 rounded-2xl bg-charcoal-2 hover:bg-charcoal-3 text-2xl font-medium active:scale-95">0</button>
              <button onClick={() => submit(pin)} disabled={pin.length < 4 || busy} className="h-16 rounded-2xl bg-gold text-charcoal font-semibold disabled:opacity-40">{t("OK")}</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
export default function Page() { return <Suspense><Login /></Suspense>; }
