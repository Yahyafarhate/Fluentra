"use client";
import { createPortal } from "react-dom";
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon, type IconName } from "../icons";
import { useT } from "@/lib/i18n/client";

export const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

/* ───────── Button ───────── */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "gold" | "subtle";
const V: Record<Variant, string> = {
  primary: "bg-charcoal text-white hover:bg-charcoal-3 active:bg-black shadow-sm",
  gold: "bg-gold text-white hover:bg-gold-strong shadow-sm",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken",
  subtle: "bg-sunken text-ink hover:bg-line",
  ghost: "text-ink-2 hover:bg-sunken",
  danger: "bg-bad text-white hover:opacity-90",
};
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; icon?: IconName; loading?: boolean }>(
  function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, type = "button", ...p }, ref) {
    const sz = size === "sm" ? "h-8 px-3 text-[13px] gap-1.5" : size === "lg" ? "h-12 px-6 text-base gap-2" : "h-10 px-4 text-sm gap-2";
    return (
      <button ref={ref} type={type} disabled={disabled || loading} className={cx("inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition select-none disabled:opacity-50 disabled:pointer-events-none", sz, V[variant], className)} {...p}>
        {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon ? <Icon name={icon} size={size === "sm" ? 15 : 17} /> : null}
        {children}
      </button>
    );
  });
export function IconButton({ icon, label, className, size = 36, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: number }) {
  return (
    <button type="button" aria-label={label} title={label} style={{ width: size, height: size }} className={cx("inline-flex items-center justify-center rounded-lg text-ink-2 hover:bg-sunken transition disabled:opacity-40", className)} {...p}>
      <Icon name={icon} size={18} />
    </button>
  );
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={cx("animate-[fl-spin_.8s_linear_infinite]", className)} role="status" aria-label="Loading"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}
export const Skeleton = ({ className }: { className?: string }) => <div className={cx("skeleton", className)} />;

/* ───────── Surfaces ───────── */
export function Card({ className, children, pad = true, ...p }: { className?: string; children: ReactNode; pad?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("bg-surface rounded-[var(--radius-card)] border border-line shadow-[var(--shadow-card)]", pad && "p-5", className)} {...p}>{children}</div>;
}
export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="min-w-0"><h3 className="text-[1.05rem] font-semibold leading-tight">{title}</h3>{subtitle && <p className="text-[13px] text-muted mt-0.5">{subtitle}</p>}</div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  );
}
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div className="min-w-0"><h1 className="text-[1.65rem] sm:text-[1.9rem] font-semibold leading-tight">{title}</h1>{subtitle && <p className="text-muted mt-1 text-sm">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ───────── Badges ───────── */
type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "gold" | "violet" | "dark";
const T: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-2", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info", gold: "bg-gold-soft text-gold-strong", violet: "bg-violet-soft text-violet", dark: "bg-charcoal text-white",
};
export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", T[tone], className)}>{dot && <span className="size-1.5 rounded-full bg-current" />}{children}</span>;
}
export const STATUS_TONE: Record<string, Tone> = {
  pending: "warn", confirmed: "info", arrived: "violet", seated: "ok", completed: "neutral", cancelled: "bad", no_show: "bad",
  waiting: "warn", notified: "info", removed: "neutral",
  available: "ok", reserved: "info", occupied: "violet", cleaning: "warn", blocked: "bad", unavailable: "neutral",
  simulated: "gold", sent: "info", delivered: "ok", failed: "bad", queued: "neutral", skipped: "neutral",
  draft: "neutral", scheduled: "info", sending: "warn", active: "ok", trial: "gold", suspended: "bad", past_due: "warn",
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const t = useT();
  const text = label ?? t(({ no_show: "No-show", past_due: "Past due" } as Record<string, string>)[status] ?? status.charAt(0).toUpperCase() + status.slice(1));
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{text}</Badge>;
}

/* ───────── Form controls ───────── */
const field = "w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted/70 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/25 disabled:bg-sunken disabled:text-muted aria-[invalid=true]:border-bad";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) { return <input ref={ref} className={cx(field, "h-10", className)} {...p} />; });
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) { return <select ref={ref} className={cx(field, "h-10 pe-8", className)} {...p}>{children}</select>; });
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) { return <textarea ref={ref} className={cx(field, "py-2 min-h-[84px]", className)} {...p} />; });

export function Field({ label, error, hint, children, className, required }: { label: ReactNode; error?: string | null; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean }) {
  const id = useId();
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2">{label}{required && <span className="text-bad ms-0.5">*</span>}</label>
      <FieldChild id={id} invalid={!!error}>{children}</FieldChild>
      {error ? <p className="text-xs text-bad" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
import { cloneElement, isValidElement } from "react";
function FieldChild({ id, invalid, children }: { id: string; invalid: boolean; children: ReactNode }) {
  return isValidElement(children) ? cloneElement(children as React.ReactElement<Record<string, unknown>>, { id, "aria-invalid": invalid || undefined }) : <>{children}</>;
}

export function Switch({ checked, onChange, label, disabled, description }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; description?: ReactNode }) {
  return (
    <label className={cx("flex items-start gap-3 cursor-pointer select-none", disabled && "opacity-50 pointer-events-none")}>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cx("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition", checked ? "bg-gold" : "bg-line-strong")}>
        <span className={cx("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", checked ? "start-[22px]" : "start-0.5")} />
      </button>
      {(label || description) && <span className="text-sm">{label}{description && <span className="block text-xs text-muted">{description}</span>}</span>}
    </label>
  );
}
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" className="size-4 accent-[var(--color-gold)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; className?: string }) {
  return (
    <div role="tablist" className={cx("inline-flex max-w-full overflow-x-auto scroll-thin rounded-lg bg-sunken p-0.5 text-sm", className)}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} type="button" onClick={() => onChange(o.value)} className={cx("px-3 h-8 rounded-md font-medium transition whitespace-nowrap", value === o.value ? "bg-surface shadow-sm text-ink" : "text-muted hover:text-ink")}>{o.label}</button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode; badge?: ReactNode }> }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line mb-5 overflow-x-auto scroll-thin">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)} type="button"
          className={cx("px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition flex items-center gap-2", value === t.value ? "border-gold text-ink" : "border-transparent text-muted hover:text-ink")}>
          {t.label}{t.badge}
        </button>
      ))}
    </div>
  );
}

/* ───────── Dialogs ───────── */
/** Open dialogs, top-most last: only the top one reacts to Escape / Tab (a confirm can open over an edit dialog). */
const dialogStack: string[] = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog rendered in a portal as a plain fixed overlay. (A native <dialog>.showModal() was dropped: on iOS Safari it
 * could open off-screen / invisible behind its backdrop.) Escape and backdrop click close it; focus is trapped and restored;
 * the page behind does not scroll.
 */
export function Dialog({ open, onClose, title, children, footer, size = "md", side = false, description }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl"; side?: boolean; description?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const id = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogStack.push(id);
    const first = panel.current?.querySelector<HTMLElement>("input,select,textarea");
    (first ?? panel.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== id) return;
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) { e.preventDefault(); return; }
      const f = items[0], l = items[items.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === f || a === panel.current)) { e.preventDefault(); l.focus(); }
      else if (!e.shiftKey && a === l) { e.preventDefault(); f.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = dialogStack.indexOf(id); if (i >= 0) dialogStack.splice(i, 1);
      document.body.style.overflow = overflow;
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, id]);

  if (!open || !mounted) return null;
  const w = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return createPortal(
    <div className="fixed inset-0 z-[90] flex">
      <div className="absolute inset-0 bg-black/50" onClick={() => close.current()} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}
        className={cx("relative bg-surface text-ink shadow-[var(--shadow-pop)] outline-none flex flex-col animate-in",
          side ? "ms-auto me-0 h-dvh w-full max-w-xl" : cx("m-auto w-[calc(100%-1.5rem)] rounded-2xl max-h-[calc(100dvh-2rem)]", w))}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 shrink-0">
          <div className="min-w-0"><h2 id={`${id}-t`} className="text-xl font-semibold">{title}</h2>{description && <p className="text-sm text-muted mt-0.5">{description}</p>}</div>
          <IconButton icon="x" label="Close" onClick={() => close.current()} />
        </div>
        <div className="px-6 pb-4 overflow-y-auto scroll-thin flex-1 min-h-0">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-line bg-canvas/60 shrink-0 rounded-b-2xl">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ───────── Feedback ───────── */
export function EmptyState({ icon = "info", title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      <div className="size-12 rounded-full bg-gold-soft text-gold-strong grid place-items-center mb-4"><Icon name={icon} size={22} /></div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <p className="text-sm text-muted mt-1 max-w-md">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, onRetry }: { error: { message: string } | null; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-bad/30 bg-bad-soft/50 p-5 text-sm flex items-start gap-3" role="alert">
      <Icon name="alert" className="text-bad mt-0.5" />
      <div className="flex-1"><p className="font-medium text-bad">{t("Something went wrong")}</p><p className="text-ink-2 mt-0.5">{error?.message}</p></div>
      {onRetry && <Button size="sm" onClick={onRetry} icon="refresh">{t("Retry")}</Button>}
    </div>
  );
}
export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "ok" | "gold" | "bad"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const c = { info: "bg-info-soft text-info", warn: "bg-warn-soft text-warn", ok: "bg-ok-soft text-ok", gold: "bg-gold-soft text-gold-strong", bad: "bg-bad-soft text-bad" }[tone];
  return (
    <div className={cx("rounded-xl px-4 py-3 text-sm flex items-start gap-3", c)}>
      <Icon name={tone === "ok" ? "check" : tone === "info" ? "info" : "alert"} size={18} className="mt-0.5" />
      <div className="flex-1 text-ink">{title && <p className="font-semibold">{title}</p>}{children && <div className="text-ink-2">{children}</div>}</div>
      {action}
    </div>
  );
}

export function Stat({ label, value, sub, icon, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: IconName; tone?: Tone }) {
  return (
    <Card className="!p-4">
      <div className="flex items-center justify-between text-[13px] text-muted"><span>{label}</span>{icon && <Icon name={icon} size={16} />}</div>
      <div className={cx("mt-1.5 text-[1.7rem] font-semibold leading-none tabular", tone === "bad" && "text-bad", tone === "ok" && "text-ok")}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

export function Avatar({ name, size = 34, vip }: { name: string; size?: number; vip?: boolean }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
  return (
    <span style={{ width: size, height: size, fontSize: size * 0.38 }} className={cx("inline-grid place-items-center rounded-full font-semibold shrink-0", vip ? "bg-gold text-white" : "bg-sunken text-ink-2")}>{initials || "?"}</span>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) { return <th className={cx("px-4 py-2.5 text-start text-xs font-semibold uppercase tracking-wide text-muted whitespace-nowrap", className)}>{children}</th>; }
export function Td({ children, className, ...p }: { children?: ReactNode; className?: string } & React.TdHTMLAttributes<HTMLTableCellElement>) { return <td className={cx("px-4 py-3 align-middle", className)} {...p}>{children}</td>; }
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto scroll-thin rounded-xl border border-line bg-surface"><table className="w-full text-sm [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_thead]:bg-canvas/70">{children}</table></div>;
}
