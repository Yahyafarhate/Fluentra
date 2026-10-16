"use client";
import type { CSSProperties, PointerEventHandler } from "react";
import { cx } from "@/components/ui";

export const DECOR_KINDS = ["pool", "basin", "wall", "door", "bar", "stage", "plant", "stairs", "label"] as const;
export type DecorKind = (typeof DECOR_KINDS)[number];
export interface FloorItem { id: string; floorId: string; kind: DecorKind; label: string | null; x: number; y: number; w: number; h: number; rotation: number }
/** Kinds that people cannot walk through: tables on either side of one are never grouped together. */
export const OBSTACLES: DecorKind[] = ["pool", "basin", "wall"];
export const DEFAULT_SIZE: Record<DecorKind, { w: number; h: number }> = {
  pool: { w: 240, h: 140 }, basin: { w: 100, h: 100 }, wall: { w: 200, h: 12 }, door: { w: 60, h: 12 }, bar: { w: 200, h: 50 },
  stage: { w: 160, h: 100 }, plant: { w: 40, h: 40 }, stairs: { w: 80, h: 100 }, label: { w: 140, h: 30 },
};
const STYLE: Record<DecorKind, string> = {
  pool: "bg-info-soft border-info/60 text-info rounded-xl",
  basin: "bg-info-soft border-info/60 text-info rounded-full",
  wall: "bg-line-strong border-line-strong rounded-sm",
  door: "bg-surface border-dashed border-gold text-gold-strong rounded-sm",
  bar: "bg-sunken border-line-strong text-ink-2 rounded-lg",
  stage: "bg-violet-soft border-violet/50 text-violet rounded-lg",
  plant: "bg-ok-soft border-ok/50 text-ok rounded-full",
  stairs: "bg-sunken border-line-strong text-muted rounded-md [background-image:repeating-linear-gradient(0deg,transparent,transparent_7px,rgb(120_120_120/0.25)_7px,rgb(120_120_120/0.25)_8px)]",
  label: "border-transparent text-ink-2",
};

export function decorName(kind: DecorKind, t: (s: string) => string): string {
  return { pool: t("Pool"), basin: t("Basin"), wall: t("Wall"), door: t("Door"), bar: t("Bar"), stage: t("Stage"), plant: t("Plant"), stairs: t("Stairs"), label: t("Text label") }[kind];
}

export function DecorNode({ item, floor, mode, selected, name, onPointerDown, children }: {
  item: FloorItem; floor: { width: number; height: number }; mode: "live" | "edit"; selected?: boolean; name: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>; children?: React.ReactNode;
}) {
  const style: CSSProperties = {
    left: `${(100 * item.x) / floor.width}%`, top: `${(100 * item.y) / floor.height}%`, width: `${(100 * item.w) / floor.width}%`, height: `${(100 * item.h) / floor.height}%`,
    transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined, touchAction: mode === "edit" ? "none" : undefined,
  };
  const text = item.label || (item.kind === "label" ? "" : name);
  return (
    <div onPointerDown={onPointerDown} style={style} aria-label={name} role={mode === "edit" ? "button" : "img"}
      className={cx("absolute border-2 flex items-center justify-center text-center select-none overflow-hidden", STYLE[item.kind],
        mode === "edit" ? "cursor-grab active:cursor-grabbing" : "pointer-events-none", selected && "ring-2 ring-gold ring-offset-2 z-10")}>
      {item.kind !== "wall" && text && <span className="text-[clamp(9px,1.2cqw,13px)] leading-tight px-1 truncate max-w-full">{text}</span>}
      {children}
    </div>
  );
}
