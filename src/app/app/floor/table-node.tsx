"use client";
import type { CSSProperties, PointerEventHandler } from "react";
import { cx } from "@/components/ui";

export interface FloorTable {
  id: string; floorId: string; sectionId: string | null; name: string; minCapacity: number; capacity: number; shape: "rect" | "round" | "square";
  x: number; y: number; w: number; h: number; rotation: number; status: string; blockedReason: string | null; bookableOnline: boolean;
  displayStatus?: "available" | "reserved" | "occupied" | "cleaning" | "blocked" | "unavailable";
  current?: null | { id: string; guestName: string; partySize: number; startLocal: string; endLocal: string; seatedAt: string | null; isVip: boolean };
  next?: null | { id: string; guestName: string; partySize: number; startLocal: string; status: string; isVip: boolean };
}

export const STATUS_STYLE: Record<string, string> = {
  available: "bg-ok-soft border-ok/60 text-ok",
  reserved: "bg-info-soft border-info/60 text-info",
  occupied: "bg-violet-soft border-violet/70 text-violet",
  cleaning: "bg-warn-soft border-warn/70 text-warn",
  blocked: "bg-bad-soft border-bad/60 text-bad [background-image:repeating-linear-gradient(45deg,transparent,transparent_6px,rgb(176_70_60/0.12)_6px,rgb(176_70_60/0.12)_12px)]",
  unavailable: "bg-sunken border-line-strong text-muted",
};

export function TableNode({ t, floor, mode, selected, dim, onClick, onPointerDown, children }: {
  t: FloorTable; floor: { width: number; height: number }; mode: "live" | "edit"; selected?: boolean; dim?: boolean;
  onClick?: (e: React.MouseEvent) => void; onPointerDown?: PointerEventHandler<HTMLDivElement>; children?: React.ReactNode;
}) {
  const style: CSSProperties = {
    left: `${(100 * t.x) / floor.width}%`, top: `${(100 * t.y) / floor.height}%`, width: `${(100 * t.w) / floor.width}%`, height: `${(100 * t.h) / floor.height}%`,
    transform: t.rotation ? `rotate(${t.rotation}deg)` : undefined, touchAction: mode === "edit" ? "none" : undefined,
  };
  const st = t.displayStatus ?? "available";
  const live = mode === "live";
  return (
    <div role="button" tabIndex={0} aria-label={`${t.name}, ${t.capacity} seats${live ? ", " + st : ""}`} aria-pressed={selected}
      onClick={onClick} onPointerDown={onPointerDown} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(e as unknown as React.MouseEvent); } }}
      style={style}
      className={cx("tbl absolute border-2 flex flex-col items-center justify-center text-center leading-tight select-none overflow-hidden",
        t.shape === "round" ? "rounded-full" : "rounded-xl", live ? STATUS_STYLE[st] : "bg-surface border-line-strong text-ink",
        mode === "edit" ? "cursor-grab active:cursor-grabbing" : "cursor-pointer", selected && "ring-2 ring-gold ring-offset-2 z-10", dim && "opacity-25")}>
      <span className="font-semibold text-[clamp(11px,1.5cqw,16px)] leading-none">{t.name}</span>
      {live && st === "occupied" && t.current ? (
        <>
          <span className="text-[clamp(9px,1.1cqw,12px)] mt-0.5 px-1 truncate max-w-full">{t.current.guestName}</span>
          <span className="text-[clamp(9px,1.1cqw,12px)] opacity-80">{t.current.partySize}p · {t.current.seatedAt ? `${Math.max(0, Math.round((Date.now() - new Date(t.current.seatedAt).getTime()) / 60000))}m` : ""}</span>
        </>
      ) : live && st === "reserved" && t.next ? (
        <>
          <span className="text-[clamp(9px,1.1cqw,12px)] mt-0.5 px-1 truncate max-w-full">{t.next.guestName}</span>
          <span className="text-[clamp(9px,1.1cqw,12px)] opacity-80">{t.next.startLocal} · {t.next.partySize}p</span>
        </>
      ) : (
        <span className="text-[clamp(9px,1.1cqw,12px)] opacity-70 mt-0.5">{t.capacity} {mode === "edit" || st === "available" ? "" : ""}{t.minCapacity > 1 ? `(${t.minCapacity}–${t.capacity})` : ""}</span>
      )}
      {live && t.next?.isVip && <span className="absolute top-0.5 end-1 text-[9px]">♛</span>}
      {children}
    </div>
  );
}
