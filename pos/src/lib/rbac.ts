export const ROLES = ["owner", "manager", "supervisor", "cashier", "server", "bartender", "kitchen"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "pos.access",
  "orders.create", "orders.edit", "orders.send", "orders.transfer", "orders.split", "orders.merge", "orders.reopen",
  "items.void_sent",           // void an item that was already sent to the kitchen (without a second approver)
  "orders.void",               // void a whole order
  "discounts.apply", "discounts.approve",
  "payments.take", "refunds.create", "refunds.approve",
  "cash.session", "cash.view_all", "day.close",
  "kds.use",
  "floor.manage", "menu.manage", "staff.manage", "settings.manage",
  "reports.view", "reports.export", "audit.view", "integration.manage",
  "approvals.grant",           // may act as the approver for another employee's restricted action
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const set = (...p: Permission[]) => new Set<Permission>(p);

const SERVICE: Permission[] = ["pos.access", "orders.create", "orders.edit", "orders.send", "orders.transfer", "orders.split", "orders.merge", "discounts.apply"];

export const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  owner: ALL,
  manager: new Set<Permission>(PERMISSIONS.filter((p) => p !== "integration.manage")), // everything except owner-only integration setup
  supervisor: set(...SERVICE, "orders.reopen", "items.void_sent", "orders.void", "discounts.approve", "payments.take", "refunds.create", "refunds.approve", "cash.session", "cash.view_all", "day.close", "kds.use", "reports.view", "approvals.grant"),
  cashier: set(...SERVICE, "payments.take", "cash.session", "refunds.create"),
  server: set(...SERVICE, "payments.take"),
  bartender: set(...SERVICE, "payments.take", "kds.use"),
  kitchen: set("pos.access", "kds.use"),
};
export const can = (role: Role, p: Permission) => ROLE_PERMISSIONS[role]?.has(p) ?? false;

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner", manager: "Manager", supervisor: "Supervisor", cashier: "Cashier", server: "Server", bartender: "Bartender", kitchen: "Kitchen",
};

/** Roles a given role may create. Nobody can grant a role above their own. */
export function assignableRoles(role: Role): Role[] {
  if (role === "owner") return [...ROLES];
  if (role === "manager") return ROLES.filter((r) => r !== "owner");
  return [];
}
