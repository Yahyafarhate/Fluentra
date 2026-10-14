export const STATUSES = ["pending", "confirmed", "arrived", "seated", "completed", "cancelled", "no_show"] as const;
export type Status = (typeof STATUSES)[number];
export const ACTIVE_STATUSES: Status[] = ["pending", "confirmed", "arrived", "seated"];

export type Action = "confirm" | "arrive" | "seat" | "complete" | "cancel" | "no_show" | "undo_arrive" | "undo_seat" | "reinstate";

/** Single source of truth for the reservation lifecycle. */
export const TRANSITIONS: Record<Action, { from: Status[]; to: Status }> = {
  confirm: { from: ["pending"], to: "confirmed" },
  arrive: { from: ["pending", "confirmed"], to: "arrived" },
  seat: { from: ["pending", "confirmed", "arrived"], to: "seated" },
  complete: { from: ["seated"], to: "completed" },
  cancel: { from: ["pending", "confirmed", "arrived"], to: "cancelled" },
  no_show: { from: ["pending", "confirmed"], to: "no_show" },
  undo_arrive: { from: ["arrived"], to: "confirmed" },
  undo_seat: { from: ["seated"], to: "arrived" },
  reinstate: { from: ["no_show"], to: "confirmed" },
};

export const canTransition = (from: Status, action: Action) => TRANSITIONS[action]?.from.includes(from) ?? false;
export const isActive = (s: Status) => ACTIVE_STATUSES.includes(s);

export function nextActions(s: Status): Action[] {
  return (Object.keys(TRANSITIONS) as Action[]).filter((a) => canTransition(s, a));
}
