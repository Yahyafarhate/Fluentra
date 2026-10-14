"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button, Dialog, cx } from "./ui";
import { useT } from "@/lib/i18n/client";
import { ApiError } from "@/lib/client/api";

type ToastKind = "success" | "error" | "info";
interface ToastItem { id: number; kind: ToastKind; text: string }
interface ConfirmOpts { title: string; message?: ReactNode; confirmLabel?: string; tone?: "danger" | "primary"; requireText?: string }
interface Feedback {
  toast: { success: (m: string) => void; error: (m: string | unknown) => void; info: (m: string) => void };
  confirm: (o: ConfirmOpts) => Promise<boolean>;
}
const Ctx = createContext<Feedback | null>(null);
export const useFeedback = () => { const c = useContext(Ctx); if (!c) throw new Error("FeedbackProvider missing"); return c; };

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState("");
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++idRef.current;
    setItems((s) => [...s.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  const value = useMemo<Feedback>(() => ({
    toast: {
      success: (m) => push("success", m), info: (m) => push("info", m),
      error: (m) => push("error", m instanceof ApiError ? m.message : m instanceof Error ? m.message : String(m)),
    },
    confirm: (o) => new Promise<boolean>((resolve) => { setTyped(""); setDlg({ ...o, resolve }); }),
  }), [push]);

  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null); };
  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="fixed z-[100] bottom-4 inset-x-0 sm:inset-x-auto sm:end-4 flex flex-col gap-2 px-4 sm:px-0 sm:w-[380px] pointer-events-none">
        {items.map((i) => (
          <div key={i.id} role={i.kind === "error" ? "alert" : "status"} className={cx("pointer-events-auto animate-in flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-[var(--shadow-pop)] text-white", i.kind === "success" ? "bg-ok" : i.kind === "error" ? "bg-bad" : "bg-charcoal-2")}>
            <Icon name={i.kind === "success" ? "check" : i.kind === "error" ? "alert" : "info"} className="mt-0.5" />
            <span className="flex-1">{i.text}</span>
            <button aria-label="Dismiss" onClick={() => setItems((s) => s.filter((x) => x.id !== i.id))} className="opacity-70 hover:opacity-100"><Icon name="x" size={16} /></button>
          </div>
        ))}
      </div>
      <Dialog open={!!dlg} onClose={() => close(false)} title={dlg?.title ?? ""} size="sm"
        footer={<><Button onClick={() => close(false)}>{t("Cancel")}</Button><Button variant={dlg?.tone === "danger" ? "danger" : "primary"} disabled={!!dlg?.requireText && typed !== dlg.requireText} onClick={() => close(true)}>{dlg?.confirmLabel ?? t("Confirm")}</Button></>}>
        <div className="text-sm text-ink-2 space-y-3">
          {dlg?.message}
          {dlg?.requireText && (
            <div><p className="mb-1">{t("Type {text} to confirm", { text: dlg.requireText })}</p>
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="h-10 w-full rounded-lg border border-line-strong px-3" aria-label="Confirmation text" /></div>
          )}
        </div>
      </Dialog>
    </Ctx.Provider>
  );
}
