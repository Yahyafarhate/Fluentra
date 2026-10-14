"use client";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app-shell";
import { Button, Card, EmptyState, ErrorState, IconButton, Input, Skeleton, cx } from "@/components/ui";
import { ReservationDrawer } from "@/components/reservation-drawer";
import { useI18n } from "@/lib/i18n/client";
import { qs } from "@/lib/client/api";
import { useApi, useLive } from "@/lib/client/hooks";
import { shiftDate } from "@/lib/client/format";

const PX = 96;
const COLOR: Record<string, string> = {
  pending: "bg-warn-soft border-warn text-warn", confirmed: "bg-info-soft border-info text-info", arrived: "bg-violet-soft border-violet text-violet",
  seated: "bg-violet border-violet text-white", completed: "bg-sunken border-line-strong text-muted",
};

export function Timeline() {
  const { t } = useI18n();
  const { locationId, today } = useApp();
  const [date, setDate] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const day = date ?? today;
  const { data, error, loading, reload } = useApi<any>(locationId && day ? `/api/v1/floor/timeline${qs({ locationId, date: day })}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useLive(locationId, reload);

  const calc = useMemo(() => {
    if (!data) return null;
    const t0 = new Date(data.dayStart).getTime();
    const blocks = (data.blocks as any[]).map((b) => ({ ...b, h0: (new Date(b.startAt).getTime() - t0) / 3600000, h1: (new Date(b.endAt).getTime() - t0) / 3600000 })); // eslint-disable-line @typescript-eslint/no-explicit-any
    const minH = Math.min(10, ...blocks.map((b) => Math.floor(b.h0))); const maxH = Math.max(24, ...blocks.map((b) => Math.ceil(b.h1)));
    const [hh, mm] = String(data.nowLabel).split(":").map(Number);
    return { blocks, startH: Math.max(0, minH), endH: Math.min(30, maxH), now: hh + mm / 60 };
  }, [data]);

  return (
    <>
      <Card className="!p-3 mb-4 flex flex-wrap items-center gap-2">
        <IconButton icon="chevronLeft" label={t("Previous day")} className="rtl:rotate-180" onClick={() => day && setDate(shiftDate(day, -1))} />
        <Input type="date" value={day ?? ""} onChange={(e) => setDate(e.target.value || null)} className="!w-40" aria-label={t("Date")} />
        <IconButton icon="chevronRight" label={t("Next day")} className="rtl:rotate-180" onClick={() => day && setDate(shiftDate(day, 1))} />
        <Button size="sm" onClick={() => setDate(today)} disabled={day === today}>{t("Today")}</Button>
        <p className="ms-auto text-xs text-muted">{t("Blocks include the preparation buffer. Completed visits show their actual duration.")}</p>
      </Card>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <Skeleton className="h-96" />}
      {data && calc && data.tables.length === 0 && <Card><EmptyState icon="table" title={t("No tables yet")} /></Card>}
      {data && calc && data.tables.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface overflow-auto scroll-thin max-h-[70vh]" dir="ltr">
          <div style={{ width: 140 + (calc.endH - calc.startH) * PX }} className="relative">
            <div className="sticky top-0 z-20 flex bg-surface border-b border-line">
              <div className="sticky left-0 z-30 w-[140px] shrink-0 bg-surface border-e border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("Table")}</div>
              {Array.from({ length: calc.endH - calc.startH }).map((_, i) => <div key={i} style={{ width: PX }} className="shrink-0 border-s border-line px-2 py-2 text-xs text-muted tabular">{String((calc.startH + i) % 24).padStart(2, "0")}:00</div>)}
            </div>
            {data.tables.map((tb: { id: string; name: string; capacity: number; sectionName: string | null }) => (
              <div key={tb.id} className="flex border-b border-line h-12 relative">
                <div className="sticky left-0 z-10 w-[140px] shrink-0 bg-surface border-e border-line px-3 flex flex-col justify-center"><span className="text-sm font-medium leading-tight">{tb.name} <span className="text-muted font-normal">· {tb.capacity}</span></span>{tb.sectionName && <span className="text-[10px] text-muted leading-tight truncate">{tb.sectionName}</span>}</div>
                <div className="relative flex-1" style={{ backgroundImage: `linear-gradient(90deg, var(--color-line) 1px, transparent 1px)`, backgroundSize: `${PX}px 100%` }}>
                  {calc.blocks.filter((b) => b.tableId === tb.id).map((b) => (
                    <button key={b.id + b.tableId} onClick={() => setOpen(b.id)} title={`${b.guestName} · ${b.partySize}p · ${b.startLocal}`}
                      style={{ left: (b.h0 - calc.startH) * PX + 1, width: Math.max(8, (b.h1 - b.h0) * PX - 2) }}
                      className={cx("absolute top-1.5 bottom-1.5 rounded-md border text-start px-2 text-xs overflow-hidden whitespace-nowrap hover:brightness-95 transition", COLOR[b.status] ?? COLOR.confirmed)}>
                      <b className="font-semibold">{b.guestName}</b> <span className="opacity-80">{b.partySize}p</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {day === today && calc.now >= calc.startH && calc.now <= calc.endH && (
              <div className="absolute top-0 bottom-0 z-20 w-px bg-bad pointer-events-none" style={{ left: 140 + (calc.now - calc.startH) * PX }}><span className="absolute -top-0 -translate-x-1/2 rounded bg-bad text-white text-[10px] px-1">{data.nowLabel}</span></div>
            )}
          </div>
        </div>
      )}
      <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} onEdit={() => setOpen(null)} />
    </>
  );
}
