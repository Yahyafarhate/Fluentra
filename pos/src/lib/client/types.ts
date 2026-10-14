export interface Me {
  employee: { id: string; name: string; email: string | null }; role: string; kind: "pos" | "backoffice"; outletId: string | null; outletIds: string[] | null;
  org: { id: string; name: string; currency: string; status: string }; permissions: string[]; testPayments: boolean; cardPayments: boolean;
}
export interface ItemView {
  id: string; productId: string | null; name: string; unitPriceCents: number; qty: number; taxRateBps: number; stationKind: string; seat: number | null; course: number; hold: boolean;
  status: string; note: string | null; allergyNote: string | null; voidReason: string | null; discountCents: number; createdAt: string; firedAt: string | null;
  modifiers: Array<{ id: string; name: string; priceDeltaCents: number }>;
}
export interface Totals { grossCents: number; itemDiscountCents: number; orderDiscountCents: number; discountedCents: number; serviceChargeCents: number; taxCents: number; totalCents: number; netSalesCents: number; taxLines: Array<{ rateBps: number; baseCents: number; taxCents: number; grossCents: number }> }
export interface OrderView {
  order: { id: string; outletId: string; orderNo: number; businessDate: string; type: string; status: string; tableId: string | null; tableLabel: string | null; covers: number; serverName: string | null; roomRef: string | null; note: string | null; openedAt: string; closedAt: string | null; billRequestedAt: string | null; tables: Array<{ id: string; label: string }>; tipCents: number };
  items: ItemView[]; discounts: Array<{ id: string; name: string; kind: string; value: number; reason: string }>; totals: Totals;
  payments: Array<{ id: string; method: string; provider: string; status: string; amountCents: number; tipCents: number; createdAt: string }>;
  refundedCents: number; paidCents: number; dueCents: number; outlet: { id: string; name: string; currency: string; pricesIncludeTax: boolean };
}
export interface MenuProduct {
  id: string; categoryId: string | null; name: string; description: string | null; priceCents: number; taxRateBps: number; stationKind: string; defaultCourse: number; allergens: string[]; available: boolean;
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; priceDeltaCents: number }> }>;
}
export interface Menu { categories: Array<{ id: string; name: string; color: string | null }>; products: MenuProduct[] }
export interface FloorTable {
  id: string; diningRoomId: string; label: string; seats: number; x: number; y: number; w: number; h: number; shape: string; status: "available" | "occupied" | "ordered" | "awaiting_payment"; checks: number;
  orders: Array<{ id: string; orderNo: number; billRequested: boolean }>; order: { id: string; orderNo: number; covers: number; serverName: string | null; openedAt: string; elapsedMin: number; alert: boolean; drafts: number } | null;
}
export interface Floor { outlet: { id: string; name: string; tableAlertMinutes: number }; rooms: Array<{ id: string; name: string }>; tables: FloorTable[]; quickOrders: Array<{ id: string; orderNo: number; type: string; serverName: string | null; openedAt: string; covers: number; sent: number }> }
export interface Staff { id: string; name: string; role: string }
