"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Notice } from "@/components/ui";
import { ApiError, authCall } from "@/lib/client/api";
import type { Staff } from "@/lib/client/types";
import { useT } from "@/lib/i18n";

export interface Approval { employeeId: string; pin: string }
const APPROVER_ROLES = ["owner", "manager", "supervisor"];

/**
 * Four-eyes helper: run `fn()` normally; if the server answers APPROVAL_REQUIRED, ask a supervisor to pick their name and
 * enter their PIN, then run `fn(approval)`. The server validates the PIN and the authority — the UI never decides.
 */
export function useApproval() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [who, setWho] = useState<string>("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const resolver = useRef<((a: Approval | null) => void) | null>(null);

  const ask = useCallback(() => new Promise<Approval | null>((resolve) => { resolver.current = resolve; setPin(""); setErr(null); setOpen(true); }), []);
  useEffect(() => {
    if (!open) return;
    const code = (() => { try { return JSON.parse(localStorage.getItem("cp_terminal_code") ?? '""'); } catch { return ""; } })();
    if (code) authCall<{ staff: Staff[] }>("GET", `/staff?code=${encodeURIComponent(code)}`).then((r) => { const s = r.staff.filter((x) => APPROVER_ROLES.includes(x.role)); setStaff(s); setWho(s[0]?.id ?? ""); }).catch(() => setErr(t("Could not load supervisors")));
  }, [open, t]);

  const close = (a: Approval | null) => { setOpen(false); resolver.current?.(a); resolver.current = null; };

  const withApproval = useCallback(async <T,>(fn: (a?: Approval) => Promise<T>): Promise<T | undefined> => {
    try { return await fn(undefined); }
    catch (e) {
      if (!(e instanceof ApiError) || e.code !== "APPROVAL_REQUIRED") throw e;
      for (;;) {
        const a = await ask(); if (!a) return undefined;
        try { return await fn(a); }
        catch (e2) { if (e2 instanceof ApiError && (e2.code === "APPROVAL_DENIED" || e2.code === "ACCOUNT_LOCKED")) { setErr(e2.message); continue; } throw e2; }
      }
    }
  }, [ask]);

  const dialog = (
    <Modal open={open} onClose={() => close(null)} title={t("Supervisor approval")}
      footer={<><Button variant="ghost" onClick={() => close(null)}>{t("Cancel")}</Button><Button disabled={!who || pin.length < 4} onClick={() => close({ employeeId: who, pin })}>{t("Approve")}</Button></>}>
      <p className="text-sm text-ink-2 mb-3">{t("This action needs a supervisor. Choose who approves and enter their PIN.")}</p>
      {staff.length === 0 ? <Notice tone="warn">{t("No supervisor is available on this terminal.")}</Notice> : (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">{staff.map((s) => <button key={s.id} onClick={() => setWho(s.id)} className={`px-3 h-10 rounded-xl border text-sm ${who === s.id ? "bg-charcoal text-white border-charcoal" : "border-line-strong"}`}>{s.name}</button>)}</div>
          <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} onKeyDown={(e) => { if (e.key === "Enter" && pin.length >= 4) close({ employeeId: who, pin }); }} placeholder="PIN" className="h-14 text-center text-2xl tracking-[.4em] rounded-xl border border-line-strong" autoFocus />
          {err && <Notice tone="bad">{err}</Notice>}
        </div>
      )}
    </Modal>
  );
  return { withApproval, dialog };
}
