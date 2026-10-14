"use client";
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { useLocale, useT } from "@/lib/i18n";

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

export function Button({ variant = "primary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "gold"; size?: "sm" | "md" | "lg" | "xl" }) {
  const v = {
    primary: "bg-charcoal text-white hover:bg-charcoal-3 disabled:bg-line-strong",
    gold: "bg-gold text-white hover:bg-gold-strong disabled:bg-line-strong",
    secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken disabled:text-muted",
    ghost: "text-ink-2 hover:bg-sunken disabled:text-muted",
    danger: "bg-bad text-white hover:opacity-90 disabled:bg-line-strong",
  }[variant];
  const s = { sm: "h-9 px-3 text-sm", md: "h-11 px-4", lg: "h-14 px-5 text-lg", xl: "h-16 px-6 text-xl" }[size];
  return <button {...p} className={cx("rounded-xl font-medium transition-colors active:scale-[.98] select-none disabled:cursor-not-allowed inline-flex items-center justify-center gap-2", v, s, className)} />;
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="block text-sm font-medium text-ink-2 mb-1">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-muted mt-1">{hint}</span>}
      {error && <span className="block text-xs text-bad mt-1" role="alert">{error}</span>}
    </label>
  );
}
const inputCls = "h-11 rounded-xl border border-line-strong bg-surface px-3 text-ink placeholder:text-muted focus:border-gold";
const widthOf = (c?: string) => (c && /(^|\s)w-/.test(c) ? "" : "w-full");
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, widthOf(p.className), p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, widthOf(p.className), p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, "w-full h-auto py-2", p.className)} />;

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => <div className={cx("bg-surface border border-line rounded-2xl shadow-card p-5", className)}>{children}</div>;

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "gold" | "violet"; children: ReactNode; className?: string }) {
  const t = { neutral: "bg-sunken text-ink-2", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", info: "bg-info-soft text-info", gold: "bg-gold-soft text-gold-strong", violet: "bg-violet-soft text-violet" }[tone];
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", t, className)}>{children}</span>;
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "ok" | "gold"; title?: string; children?: ReactNode }) {
  const t = { info: "bg-info-soft border-info/30 text-info", warn: "bg-warn-soft border-warn/30 text-warn", bad: "bg-bad-soft border-bad/30 text-bad", ok: "bg-ok-soft border-ok/30 text-ok", gold: "bg-gold-soft border-gold/30 text-gold-strong" }[tone];
  return <div role={tone === "bad" ? "alert" : "status"} className={cx("rounded-xl border px-4 py-3 text-sm", t)}>{title && <div className="font-semibold">{title}</div>}{children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}</div>;
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin text-muted" aria-label="loading" role="status"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="42" strokeLinecap="round" /></svg>;
}
export const Loading = () => <div className="flex justify-center py-16"><Spinner size={28} /></div>;
export function ErrorState({ error, retry }: { error: { message: string } | null; retry?: () => void }) {
  const t = useT();
  return <div className="py-12 text-center"><Notice tone="bad" title={t("Something went wrong")}>{error?.message}</Notice>{retry && <Button variant="secondary" className="mt-4" onClick={retry}>{t("Retry")}</Button>}</div>;
}
export const Empty = ({ title, hint }: { title: string; hint?: string }) => <div className="py-12 text-center text-muted"><div className="font-medium text-ink-2">{title}</div>{hint && <div className="text-sm mt-1">{hint}</div>}</div>;

/** Native <dialog> modal: focus-trapped, Escape closes, backdrop click closes. */
export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cx("m-auto rounded-2xl p-0 shadow-pop bg-surface text-ink w-[calc(100%-24px)] max-h-[92dvh] overflow-hidden", wide ? "max-w-3xl" : "max-w-md")}>
      {open && (
        <div className="flex flex-col max-h-[92dvh]">
          <div className="flex items-center justify-between px-5 py-3 border-b border-line"><h2 className="text-lg font-semibold">{title}</h2><button onClick={onClose} aria-label="Close" className="size-9 rounded-lg hover:bg-sunken text-xl leading-none">×</button></div>
          <div className="p-5 overflow-y-auto scroll-thin">{children}</div>
          {footer && <div className="px-5 py-3 border-t border-line flex gap-2 justify-end bg-canvas">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return <div role="tablist" className="flex gap-1 overflow-x-auto scroll-thin">{tabs.map((x) => <button key={x.id} role="tab" aria-selected={value === x.id} onClick={() => onChange(x.id)} className={cx("h-10 px-4 rounded-xl text-sm font-medium whitespace-nowrap", value === x.id ? "bg-charcoal text-white" : "text-ink-2 hover:bg-sunken")}>{x.label}</button>)}</div>;
}

export function Logo({ compact }: { compact?: boolean }) {
  return <span className="inline-flex items-center gap-2"><span className="size-8 rounded-lg bg-charcoal text-gold grid place-items-center font-display font-bold" aria-hidden>C</span>{!compact && <span className="font-display text-lg font-semibold tracking-tight">Comptoir</span>}</span>;
}

export function LangSwitch() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return <select aria-label={t("Language")} value={locale} onChange={(e) => setLocale(e.target.value as "fr" | "en" | "ar")} className="h-9 rounded-lg border border-line-strong bg-surface text-ink text-sm px-2"><option value="fr">FR</option><option value="en">EN</option><option value="ar" disabled>AR (soon)</option></select>;
}
