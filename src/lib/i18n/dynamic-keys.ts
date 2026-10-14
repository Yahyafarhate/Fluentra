/** Strings that reach t() through lookup tables / computed values, so the extractor cannot see them. */
export const DYNAMIC_KEYS = [
  // navigation
  "Dashboard", "Reservations", "Floor plan", "Waitlist", "Guests", "Marketing", "Automations", "Analytics", "Team", "Settings", "Billing",
  // statuses
  "Pending", "Confirmed", "Arrived", "Seated", "Completed", "Cancelled", "No-show", "Waiting", "Notified", "Removed", "Available", "Reserved", "Occupied", "Cleaning", "Blocked", "Unavailable",
  "Simulated", "Sent", "Delivered", "Failed", "Queued", "Skipped", "Draft", "Scheduled", "Sending", "Active", "Trial", "Suspended", "Past due",
  "available", "reserved", "occupied", "cleaning", "blocked", "pending", "paid", "waived", "none", "refunded", "indoor", "outdoor", "terrace", "bar", "private", "seated", "removed", "cancelled", "failed", "sent", "queued", "delivered", "skipped",
  // sources & occasions
  "Phone", "Online", "Walk-in", "Instagram", "WhatsApp", "Google", "Email", "Staff", "Other",
  "Birthday", "Anniversary", "Business dinner", "Engagement", "Date night", "Family gathering", "Celebration",
  // roles
  "Owner", "General manager", "Restaurant manager", "Host / receptionist", "Service team", "Marketing manager", "Host", "Service",
  "Everything, including billing and team.", "Everything except billing.", "Run reservations, floor plan, guests, reports and booking settings for assigned locations.",
  "Take bookings, check guests in, seat and release tables, manage the waitlist.", "See reservations and the floor, mark tables ready.", "Guests, campaigns, automations and analytics. No operational controls.",
  // automations & templates
  "Reservation created", "Reservation confirmed", "Reservation modified", "Reservation cancelled", "Reminder before arrival", "After the visit", "Feedback request after visit", "Guest birthday", "Guest anniversary", "Waitlist: table ready",
  "Booking confirmation", "Request received (pending)", "Reminder", "Booking modified", "Booking cancelled", "Waitlist joined", "Table ready", "Thank-you after visit", "Feedback request", "Birthday greeting", "Anniversary greeting",
  "booking confirmation", "booking pending", "booking reminder", "booking modified", "booking cancelled", "waitlist ready", "followup thanks", "feedback request", "birthday greeting", "anniversary greeting", "waitlist joined",
  "returning guest", "special occasion", "event", "birthday",
  // waitlist priority
  "Standard", "Accessibility need", "Has a reservation commitment", "VIP", "Other (note required)",
  // booking reasons
  "Fully booked", "Cover limit for this slot", "Service is full", "Too soon", "Beyond booking window", "In the past", "Party too large", "Party too small", "Closed",
  "Too soon to book online", "Too far ahead", "Please call us for larger groups",
  // misc dynamic
  "None", "Unavailable", "Yes", "No", "Month", "month", "Locations", "Team members (incl. invitations)", "Reservations this month", "Guest CRM", "Waitlist & walk-ins", "CSV exports", "Custom automations", "Marketing campaigns", "Multi-location", "Custom branding", "Deposits", "Forecasting", "API access",
  "Bookings", "Covers", "Reservations", "Cancellation rate", "No-show rate", "Avg seating duration", "Table utilization", "Waitlist conversion", "First-time vs returning", "Revenue & avg spend", "Forecast",
  "Bookings excluding cancelled and no-show (the guest party, not people).", "Sum of party sizes of those reservations (people).", "Cancelled ÷ all bookings made for the period.",
  "No-shows ÷ (bookings that were honoured or missed: completed, seated, arrived, no-show).", "Measured from seated to left on completed visits only.",
  "Occupied table-minutes of completed visits ÷ (active tables × scheduled service minutes). Different from covers or bookings.", "Waitlist entries seated ÷ all entries joined in the period.",
  "A visit is “returning” if the guest has an earlier recorded visit.", "Measured only from spend entered per visit (or a POS). Visits without spend are excluded; coverage is always shown.",
  "An ESTIMATE: average of the same weekday over the last 8 weeks, never below what is already booked.",
  "immediately", "day(s)", "hour(s)", "min", "on the day", "at the time",
  "No spend has been recorded for this period. Revenue is only shown from spend entered per visit (or a connected POS).",
  "Permission", "Marketing consent", "Private event / large group", "Locations", "Organization", "Location",
] as const;
