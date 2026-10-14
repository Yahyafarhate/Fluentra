"use client";
import { useId, useState } from "react";
import { cx } from "./ui";

/* Lightweight accessible SVG charts (no dependencies). Values are always real data passed in by callers. */
const GOLD = "var(--color-gold)";

export function BarChart({ data, height = 180, color = GOLD, format = (n: number) => String(n), highlight }: {
  data: Array<{ label: string; value: number; sub?: string }>; height?: number; color?: string; format?: (n: number) => string; highlight?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 600, pad = { t: 14, b: 26, l: 8, r: 8 };
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const H = height;
  if (!data.length) return null;
  const step = Math.ceil(data.length / 12);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(", ")}>
        {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + (H - pad.t - pad.b) * (1 - f)} y2={pad.t + (H - pad.t - pad.b) * (1 - f)} stroke="var(--color-line)" strokeDasharray="3 4" />)}
        {data.map((d, i) => {
          const h = ((H - pad.t - pad.b) * d.value) / max;
          const x = pad.l + i * bw + bw * 0.14;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={x} y={H - pad.b - h} width={bw * 0.72} height={Math.max(h, d.value > 0 ? 2 : 0)} rx={3} fill={color} opacity={hover === null || hover === i ? (highlight === i ? 1 : 0.88) : 0.4} />
              {i % step === 0 && <text x={x + bw * 0.36} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-muted)">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 start-1/2 -translate-x-1/2 rounded-lg bg-charcoal text-white text-xs px-2.5 py-1.5 shadow-lg whitespace-nowrap">
          <b>{format(data[hover].value)}</b> · {data[hover].label}{data[hover].sub ? ` · ${data[hover].sub}` : ""}
        </div>
      )}
    </div>
  );
}

export function LineChart({ series, labels, height = 190, format = (n: number) => String(n) }: {
  series: Array<{ name: string; values: number[]; color: string }>; labels: string[]; height?: number; format?: (n: number) => string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = height, pad = { t: 14, b: 26, l: 8, r: 8 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = labels.length;
  if (n < 2) return null;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (n - 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const step = Math.ceil(n / 8);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={series.map((s) => s.name).join(", ")} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width * W - pad.l) / ((W - pad.l - pad.r) / (n - 1))); setHover(Math.max(0, Math.min(n - 1, i))); }}>
        {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + (H - pad.t - pad.b) * (1 - f)} y2={pad.t + (H - pad.t - pad.b) * (1 - f)} stroke="var(--color-line)" strokeDasharray="3 4" />)}
        {series.map((s, si) => (
          <g key={s.name}>
            <defs><linearGradient id={`${id}${si}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity=".22" /><stop offset="100%" stopColor={s.color} stopOpacity="0" /></linearGradient></defs>
            {si === 0 && <path d={`M${x(0)},${y(s.values[0])} ${s.values.map((v, i) => `L${x(i)},${y(v)}`).join(" ")} L${x(n - 1)},${H - pad.b} L${x(0)},${H - pad.b} Z`} fill={`url(#${id}${si})`} />}
            <path d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {labels.map((l, i) => i % step === 0 && <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-muted)">{l}</text>)}
        {hover !== null && <><line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--color-line-strong)" />{series.map((s) => <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r="4" fill="white" stroke={s.color} strokeWidth="2" />)}</>}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 start-1/2 -translate-x-1/2 rounded-lg bg-charcoal text-white text-xs px-2.5 py-1.5 shadow-lg whitespace-nowrap">
          {labels[hover]} · {series.map((s) => `${s.name}: ${format(s.values[hover])}`).join(" · ")}
        </div>
      )}
      <div className="mt-2 flex gap-4 text-xs text-muted">{series.map((s) => <span key={s.name} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

export function Meter({ value, max, tone = "gold", label }: { value: number; max: number; tone?: "gold" | "ok" | "bad"; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((100 * value) / max)) : 0;
  return <div className="h-2 rounded-full bg-sunken overflow-hidden" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}><div className={cx("h-full rounded-full transition-all", tone === "gold" ? "bg-gold" : tone === "ok" ? "bg-ok" : "bg-bad")} style={{ width: `${pct}%` }} /></div>;
}

export function HBar({ rows, format = (n: number) => String(n) }: { rows: Array<{ label: string; value: number; sub?: string }>; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex justify-between mb-1"><span className="truncate pe-3">{r.label}</span><span className="tabular text-ink-2">{format(r.value)}{r.sub ? <span className="text-muted"> · {r.sub}</span> : null}</span></div>
          <Meter value={r.value} max={max} label={r.label} />
        </li>
      ))}
    </ul>
  );
}
