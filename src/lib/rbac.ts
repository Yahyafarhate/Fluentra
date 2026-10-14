export const ROLES = ["owner", "general_manager", "restaurant_manager", "host", "service", "marketing_manager"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard.view",
  "reservations.read", "reservations.write", "reservations.operate",
  "floor.view", "floor.operate", "floor.manage",
  "waitlist.manage",
  "customers.read", "customers.write", "customers.merge", "customers.export", "customers.privacy",
  "marketing.manage",
  "automations.manage",
  "analytics.view", "analytics.export",
  "settings.manage", "locations.manage",
  "team.manage",
  "billing.manage",
  "audit.view",
  "integrations.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const without = (...p: Permission[]) => new Set<Permission>(PERMISSIONS.filter((x) => !p.includes(x)));

export const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  owner: ALL,
  general_manager: without("billing.manage"),
  restaurant_manager: new Set<Permission>([
    "dashboard.view", "reservations.read", "reservations.write", "reservations.operate",
    "floor.view", "floor.operate", "floor.manage", "waitlist.manage",
    "customers.read", "customers.write", "customers.merge", "customers.export",
    "analytics.view", "settings.manage", "audit.view",
  ]),
  host: new Set<Permission>([
    "dashboard.view", "reservations.read", "reservations.write", "reservations.operate",
    "floor.view", "floor.operate", "waitlist.manage", "customers.read", "customers.write",
  ]),
  service: new Set<Permission>(["dashboard.view", "reservations.read", "floor.view", "floor.operate", "customers.read"]),
  marketing_manager: new Set<Permission>([
    "dashboard.view", "customers.read", "customers.export", "marketing.manage", "automations.manage", "analytics.view", "analytics.export",
  ]),
};

export const can = (role: Role, p: Permission) => ROLE_PERMISSIONS[role]?.has(p) ?? false;

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner", general_manager: "General manager", restaurant_manager: "Restaurant manager",
  host: "Host / receptionist", service: "Service team", marketing_manager: "Marketing manager",
};

/** Roles a given role may grant. Nobody can grant a role above their own. */
export function assignableRoles(role: Role): Role[] {
  if (role === "owner") return [...ROLES];
  if (role === "general_manager") return ROLES.filter((r) => r !== "owner");
  return [];
}
