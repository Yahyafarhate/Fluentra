/** Keys passed to t() as variables (enum values rendered in the UI). Covered by the i18n test. */
export const DYNAMIC_KEYS = [
  // roles
  "owner", "manager", "supervisor", "cashier", "server", "bartender", "kitchen",
  // order statuses and types
  "open", "closed", "void", "merged", "dine_in", "takeaway", "room_service", "delivery",
  // item statuses
  "draft", "held", "fired", "accepted", "preparing", "ready", "served",
  // table states
  "available", "occupied", "ordered", "awaiting_payment",
  // payment methods / outcomes
  "cash", "card", "other", "approve", "decline", "pending", "delivered", "dead", "skipped",
  // stations / shapes / cash
  "bar", "pastry", "none", "square", "round", "rect", "pay_in", "pay_out",
] as const;

/** Strings reached through ternaries / lookups that the literal extractor cannot see. */
export const INDIRECT_KEYS = [
  "Discounts used",
  "Sales totals, orders, payments, cash sessions, day close", "Item lines of each order (product mix)", "Refunds and voids", "Kitchen delay events",
  // DataTable column labels derived from API field names
  "Name", "Qty", "Gross", "Category", "Price", "Station kind", "Available", "Active", "Kind", "Value", "Approval threshold bps", "Rate bps", "Email", "Access", "Locked",
  "Method", "Count", "Amount", "Refunded", "Order no", "Reason", "By", "Approved by", "At", "Created at", "Closed at", "Business date", "Type", "Tip", "Server name",
  "Billed", "Paid", "Drawer", "Expected cash", "Counted cash", "Variance", "Date", "Hour", "Net sales", "Status", "Attempts", "Last error", "Occurred at", "Next attempt at",
  "Event id", "Received at", "Action", "Actor label", "Metadata", "Turns", "Table label", "Avg minutes", "Item discount", "Total", "Tips", "Orders", "Covers", "Tax",
] as const;
