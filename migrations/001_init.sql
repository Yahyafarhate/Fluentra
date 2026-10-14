-- Fluentra initial schema
-- Conventions:
--   * every tenant-owned table has org_id; cross-table references use composite FKs (id, org_id)
--     so a record can never reference a row that belongs to another organization.
--   * Row Level Security is FORCED on every tenant table: the runtime role only sees rows for
--     app.org_id (set per transaction) unless app.system = 'on' (explicit, audited code paths).
--   * Double-booking is prevented by a GiST exclusion constraint on reservation_tables.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_system() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ───────────────────────── Plans & organizations ─────────────────────────
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  price_mad_monthly integer NOT NULL DEFAULT 0,
  max_locations integer,            -- NULL = unlimited
  max_users integer,
  max_monthly_reservations integer,
  features text[] NOT NULL DEFAULT '{}',
  sort integer NOT NULL DEFAULT 0
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug citext NOT NULL UNIQUE,
  plan_id text NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  billing_provider text,
  billing_customer_id text,
  current_period_end timestamptz,
  country text NOT NULL DEFAULT 'MA',
  locale text NOT NULL DEFAULT 'fr',
  retention_months integer NOT NULL DEFAULT 36 CHECK (retention_months BETWEEN 6 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Users & access ─────────────────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  phone text,
  locale text NOT NULL DEFAULT 'fr',
  is_super_admin boolean NOT NULL DEFAULT false,
  disabled boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','general_manager','restaurant_manager','host','service','marketing_manager')),
  location_ids uuid[],              -- NULL = all locations of the organization
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','general_manager','restaurant_manager','host','service','marketing_manager')),
  location_ids uuid[],
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Locations & configuration ─────────────────────────
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug citext NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  timezone text NOT NULL DEFAULT 'Africa/Casablanca',
  address text, city text, country text NOT NULL DEFAULT 'MA',
  phone text, email text, website text, description text,
  logo_url text, cover_url text,
  gallery text[] NOT NULL DEFAULT '{}',
  brand_color text NOT NULL DEFAULT '#b08d57',
  currency text NOT NULL DEFAULT 'MAD',
  default_locale text NOT NULL DEFAULT 'fr',
  -- booking policy
  slot_interval_min integer NOT NULL DEFAULT 15 CHECK (slot_interval_min BETWEEN 5 AND 120),
  buffer_min integer NOT NULL DEFAULT 10 CHECK (buffer_min BETWEEN 0 AND 120),
  duration_rules jsonb NOT NULL DEFAULT '[{"maxParty":2,"minutes":90},{"maxParty":4,"minutes":105},{"maxParty":8,"minutes":120},{"maxParty":999,"minutes":150}]',
  min_party integer NOT NULL DEFAULT 1 CHECK (min_party >= 1),
  max_party_online integer NOT NULL DEFAULT 8 CHECK (max_party_online >= 1),
  max_party integer NOT NULL DEFAULT 40 CHECK (max_party >= 1),
  booking_window_days integer NOT NULL DEFAULT 60 CHECK (booking_window_days BETWEEN 1 AND 730),
  min_notice_min integer NOT NULL DEFAULT 60 CHECK (min_notice_min >= 0),
  cancel_deadline_hours integer NOT NULL DEFAULT 4 CHECK (cancel_deadline_hours >= 0),
  auto_confirm boolean NOT NULL DEFAULT true,
  online_booking_enabled boolean NOT NULL DEFAULT true,
  max_covers_per_slot integer CHECK (max_covers_per_slot IS NULL OR max_covers_per_slot > 0),
  waitlist_enabled boolean NOT NULL DEFAULT true,
  public_waitlist_enabled boolean NOT NULL DEFAULT false,
  deposit_enabled boolean NOT NULL DEFAULT false,
  deposit_amount_per_guest numeric(10,2) NOT NULL DEFAULT 0,
  deposit_min_party integer NOT NULL DEFAULT 6,
  cleaning_workflow boolean NOT NULL DEFAULT true,
  no_show_grace_min integer NOT NULL DEFAULT 15,
  hold_minutes integer NOT NULL DEFAULT 10 CHECK (hold_minutes BETWEEN 1 AND 60),
  policy_text text,
  waitlist_priority jsonb NOT NULL DEFAULT '{"accessibility":2,"reservation_commitment":1}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX locations_org_idx ON locations(org_id);
CREATE TRIGGER locations_touch BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A service period (e.g. Lunch / Dinner) also defines opening hours for the days it covers.
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text NOT NULL,
  days smallint[] NOT NULL,          -- ISO weekdays 1 (Mon) .. 7 (Sun)
  start_time time NOT NULL,
  last_seating time NOT NULL,
  slot_interval_min integer CHECK (slot_interval_min IS NULL OR slot_interval_min BETWEEN 5 AND 120),
  max_covers integer CHECK (max_covers IS NULL OR max_covers > 0),
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  CHECK (last_seating > start_time),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);
CREATE INDEX services_loc_idx ON services(location_id);

CREATE TABLE special_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  date date NOT NULL,
  closed boolean NOT NULL DEFAULT true,
  label text,
  start_time time,
  last_seating time,
  UNIQUE (location_id, date),
  CHECK (closed OR (start_time IS NOT NULL AND last_seating IS NOT NULL AND last_seating > start_time)),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);

-- ───────────────────────── Floor plan ─────────────────────────
CREATE TABLE floors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  width integer NOT NULL DEFAULT 1000,
  height integer NOT NULL DEFAULT 640,
  UNIQUE (id, org_id),
  UNIQUE (location_id, name),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);

CREATE TABLE sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'indoor' CHECK (kind IN ('indoor','outdoor','private','bar','terrace')),
  sort integer NOT NULL DEFAULT 0,
  UNIQUE (id, org_id),
  UNIQUE (location_id, name),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);

CREATE TABLE tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  floor_id uuid NOT NULL,
  section_id uuid,
  name text NOT NULL,
  min_capacity integer NOT NULL DEFAULT 1 CHECK (min_capacity >= 1),
  capacity integer NOT NULL CHECK (capacity >= 1 AND capacity <= 100),
  shape text NOT NULL DEFAULT 'rect' CHECK (shape IN ('rect','round','square')),
  x integer NOT NULL DEFAULT 20, y integer NOT NULL DEFAULT 20,
  w integer NOT NULL DEFAULT 90 CHECK (w BETWEEN 30 AND 600),
  h integer NOT NULL DEFAULT 70 CHECK (h BETWEEN 30 AND 600),
  rotation integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','cleaning','blocked')),
  blocked_reason text,
  bookable_online boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_capacity <= capacity),
  UNIQUE (id, org_id),
  UNIQUE (location_id, name),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (floor_id, org_id) REFERENCES floors(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (section_id, org_id) REFERENCES sections(id, org_id) ON DELETE SET NULL (section_id)
);
CREATE INDEX tables_loc_idx ON tables(location_id);

CREATE TABLE table_combinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text NOT NULL,
  min_capacity integer NOT NULL DEFAULT 1,
  capacity integer NOT NULL CHECK (capacity >= 2),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);

CREATE TABLE table_combination_tables (
  combination_id uuid NOT NULL,
  table_id uuid NOT NULL,
  org_id uuid NOT NULL,
  PRIMARY KEY (combination_id, table_id),
  FOREIGN KEY (combination_id, org_id) REFERENCES table_combinations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (table_id, org_id) REFERENCES tables(id, org_id) ON DELETE CASCADE
);

-- ───────────────────────── Customers (CRM) ─────────────────────────
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,                        -- normalized E.164-like (+212...)
  email citext,
  language text,
  vip boolean NOT NULL DEFAULT false,
  tags text[] NOT NULL DEFAULT '{}',
  dietary text[] NOT NULL DEFAULT '{}',
  allergies text[] NOT NULL DEFAULT '{}',
  seating_preferences text,
  preferred_location_id uuid,
  birthday date,
  anniversary date,
  notes text,
  source text,
  consent_email boolean NOT NULL DEFAULT false,
  consent_sms boolean NOT NULL DEFAULT false,
  consent_whatsapp boolean NOT NULL DEFAULT false,
  merged_into uuid,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (preferred_location_id, org_id) REFERENCES locations(id, org_id) ON DELETE SET NULL (preferred_location_id),
  FOREIGN KEY (merged_into, org_id) REFERENCES customers(id, org_id)
);
CREATE UNIQUE INDEX customers_phone_uq ON customers(org_id, phone)
  WHERE phone IS NOT NULL AND merged_into IS NULL AND anonymized_at IS NULL;
CREATE UNIQUE INDEX customers_email_uq ON customers(org_id, email)
  WHERE email IS NOT NULL AND merged_into IS NULL AND anonymized_at IS NULL;
CREATE INDEX customers_name_idx ON customers(org_id, lower(name));
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Append-only consent ledger
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  granted boolean NOT NULL,
  source text NOT NULL,              -- booking_form | staff | unsubscribe_link | import | api
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE CASCADE
);
CREATE INDEX consents_customer_idx ON consents(customer_id);

-- ───────────────────────── Offers, campaigns (declared early: referenced by reservations) ─────────────────────────
CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  description text,
  kind text NOT NULL DEFAULT 'returning_guest' CHECK (kind IN ('returning_guest','birthday','special_occasion','event')),
  valid_from date, valid_to date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  criteria jsonb NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid,
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  segment_id uuid,
  offer_id uuid,
  subject text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled','failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE SET NULL (location_id),
  FOREIGN KEY (segment_id, org_id) REFERENCES segments(id, org_id) ON DELETE SET NULL (segment_id),
  FOREIGN KEY (offer_id, org_id) REFERENCES offers(id, org_id) ON DELETE SET NULL (offer_id)
);

-- ───────────────────────── Reservations ─────────────────────────
CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  customer_id uuid,
  code text NOT NULL UNIQUE,
  guest_name text NOT NULL,
  guest_phone text,
  guest_email citext,
  party_size integer NOT NULL CHECK (party_size >= 1 AND party_size <= 500),
  service_date date NOT NULL,        -- date in the location's timezone
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  service_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','arrived','seated','completed','cancelled','no_show')),
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('online','phone','walk_in','instagram','whatsapp','google','staff','email','other')),
  occasion text,
  special_requests text,
  internal_notes text,
  seating_preference text,
  is_vip boolean NOT NULL DEFAULT false,
  is_private_event boolean NOT NULL DEFAULT false,
  language text,
  deposit_status text NOT NULL DEFAULT 'none' CHECK (deposit_status IN ('none','pending','paid','waived','refunded')),
  deposit_amount numeric(10,2) NOT NULL DEFAULT 0,
  campaign_id uuid,
  offer_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  arrived_at timestamptz, seated_at timestamptz, completed_at timestamptz,
  cancelled_at timestamptz, cancelled_by text CHECK (cancelled_by IN ('guest','staff')), cancel_reason text,
  no_show_at timestamptz,
  reschedule_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (service_id, org_id) REFERENCES services(id, org_id) ON DELETE SET NULL (service_id),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns(id, org_id) ON DELETE SET NULL (campaign_id),
  FOREIGN KEY (offer_id, org_id) REFERENCES offers(id, org_id) ON DELETE SET NULL (offer_id)
);
CREATE INDEX reservations_loc_date_idx ON reservations(location_id, service_date);
CREATE INDEX reservations_loc_start_idx ON reservations(location_id, start_at);
CREATE INDEX reservations_customer_idx ON reservations(org_id, customer_id);
CREATE INDEX reservations_phone_idx ON reservations(org_id, guest_phone);
-- Exact duplicate protection (double submit / double click): same phone + location + start while active.
CREATE UNIQUE INDEX reservations_no_exact_dup ON reservations(location_id, start_at, guest_phone)
  WHERE guest_phone IS NOT NULL AND status IN ('pending','confirmed','arrived','seated');
CREATE TRIGGER reservations_touch BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The authoritative guard against double-booking: no two assignments of the same table may overlap in time.
-- The range includes the configured preparation buffer. Rows are removed when a reservation is cancelled / no-show
-- and truncated to the actual end when a reservation completes.
CREATE TABLE reservation_tables (
  reservation_id uuid NOT NULL,
  table_id uuid NOT NULL,
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  during tstzrange NOT NULL,
  PRIMARY KEY (reservation_id, table_id),
  FOREIGN KEY (reservation_id, org_id) REFERENCES reservations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (table_id, org_id) REFERENCES tables(id, org_id) ON DELETE CASCADE,
  CONSTRAINT reservation_tables_no_overlap EXCLUDE USING gist (table_id WITH =, during WITH &&)
);
CREATE INDEX reservation_tables_loc_idx ON reservation_tables(location_id);

-- Temporary slot holds used by the public booking flow (validated under the same location lock).
CREATE TABLE slot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  party_size integer NOT NULL,
  table_ids uuid[] NOT NULL,
  during tstzrange NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);
CREATE INDEX slot_holds_loc_idx ON slot_holds(location_id, expires_at);

-- ───────────────────────── Waitlist ─────────────────────────
CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  customer_id uuid,
  name text NOT NULL,
  phone text,
  email citext,
  party_size integer NOT NULL CHECK (party_size >= 1 AND party_size <= 100),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','seated','removed','cancelled')),
  priority integer NOT NULL DEFAULT 0,
  priority_reason text CHECK (priority_reason IN ('accessibility','reservation_commitment','vip','other')),
  seating_preference text,
  notes text,
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','online')),
  quoted_wait_min integer,
  joined_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  seated_at timestamptz,
  closed_at timestamptz,
  reservation_id uuid,
  public_token_hash text UNIQUE,
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (reservation_id, org_id) REFERENCES reservations(id, org_id) ON DELETE SET NULL (reservation_id)
);
CREATE INDEX waitlist_loc_idx ON waitlist_entries(location_id, status, joined_at);

-- ───────────────────────── Visits & feedback ─────────────────────────
CREATE TABLE visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  customer_id uuid,
  reservation_id uuid,
  waitlist_entry_id uuid,
  party_size integer NOT NULL,
  table_ids uuid[] NOT NULL DEFAULT '{}',
  seated_at timestamptz NOT NULL,
  left_at timestamptz,
  spend_amount numeric(12,2) CHECK (spend_amount IS NULL OR spend_amount >= 0),
  spend_source text CHECK (spend_source IN ('manual','pos')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (reservation_id, org_id) REFERENCES reservations(id, org_id) ON DELETE SET NULL (reservation_id),
  FOREIGN KEY (waitlist_entry_id, org_id) REFERENCES waitlist_entries(id, org_id) ON DELETE SET NULL (waitlist_entry_id)
);
CREATE UNIQUE INDEX visits_reservation_uq ON visits(reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX visits_loc_idx ON visits(location_id, seated_at);
CREATE INDEX visits_customer_idx ON visits(org_id, customer_id);

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  customer_id uuid,
  visit_id uuid,
  token_hash text NOT NULL UNIQUE,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  comment text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (visit_id, org_id) REFERENCES visits(id, org_id) ON DELETE SET NULL (visit_id)
);

-- ───────────────────────── Notifications & automation ─────────────────────────
CREATE TABLE notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  locale text NOT NULL CHECK (locale IN ('fr','en','ar')),
  subject text,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key, channel, locale)
);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email','sms','whatsapp','payments','pos')),
  provider text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',       -- non-secret settings only; secrets live in environment variables
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_message text,
  UNIQUE (org_id, kind)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid,
  customer_id uuid,
  reservation_id uuid,
  campaign_id uuid,
  template_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  to_address text NOT NULL,
  locale text NOT NULL DEFAULT 'fr',
  subject text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','simulated','skipped')),
  provider text,
  provider_message_id text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE SET NULL (location_id),
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (reservation_id, org_id) REFERENCES reservations(id, org_id) ON DELETE SET NULL (reservation_id),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns(id, org_id) ON DELETE SET NULL (campaign_id)
);
CREATE INDEX notifications_org_idx ON notifications(org_id, created_at DESC);
CREATE INDEX notifications_campaign_idx ON notifications(campaign_id);

CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  notification_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','simulated','skipped')),
  UNIQUE (campaign_id, customer_id),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers(id, org_id) ON DELETE CASCADE
);

CREATE TABLE automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid,
  name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN (
    'reservation_created','reservation_confirmed','reservation_modified','reservation_cancelled',
    'reminder_before','visit_completed','feedback_request','birthday','anniversary','waitlist_ready')),
  offset_minutes integer NOT NULL DEFAULT 0,
  conditions jsonb NOT NULL DEFAULT '{}',
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  template_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE
);

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  customer_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','simulated','skipped','failed')),
  detail text,
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (rule_id, org_id) REFERENCES automation_rules(id, org_id) ON DELETE CASCADE
);
CREATE INDEX automation_runs_rule_idx ON automation_runs(rule_id, created_at DESC);

-- ───────────────────────── Platform tables ─────────────────────────
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id uuid,
  actor_label text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_logs(org_id, created_at DESC);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  org_id uuid,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  locked_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_due_idx ON jobs(status, run_at);

CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid,
  kind text NOT NULL CHECK (kind IN ('logo','cover','gallery')),
  content_type text NOT NULL,
  size integer NOT NULL,
  storage_key text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Row Level Security ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'memberships','invitations','locations','services','special_days','floors','sections','tables',
    'table_combinations','table_combination_tables','customers','consents','offers','segments','campaigns',
    'reservations','reservation_tables','slot_holds','waitlist_entries','visits','feedback',
    'notification_templates','integrations','notifications','campaign_recipients','automation_rules',
    'automation_runs','uploads','subscription_events'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_system() OR org_id = app_org()) WITH CHECK (app_system() OR org_id = app_org())', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (app_system() OR id = app_org()) WITH CHECK (app_system() OR id = app_org());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs
  USING (app_system() OR org_id = app_org()) WITH CHECK (app_system() OR org_id = app_org());

-- users are visible to a tenant only through its memberships
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (app_system() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = app_org()))
  WITH CHECK (app_system());

-- platform-only tables: system scope only
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['sessions','password_resets','rate_limits'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY system_only ON %I USING (app_system()) WITH CHECK (app_system())', t);
  END LOOP;
END $$;

-- jobs: tenants may enqueue/see only their own; platform jobs (org_id NULL) are system-only
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs USING (app_system() OR org_id = app_org()) WITH CHECK (app_system() OR org_id = app_org());

-- ───────────────────────── Seed reference data: plans ─────────────────────────
INSERT INTO plans (id, name, price_mad_monthly, max_locations, max_users, max_monthly_reservations, features, sort) VALUES
 ('trial',      'Trial',      0,    1,    5,    300,  ARRAY['crm','waitlist','analytics'], 0),
 ('starter',    'Starter',    490,  1,    5,    500,  ARRAY['crm','waitlist','analytics'], 1),
 ('pro',        'Pro',        1490, 3,    20,   5000, ARRAY['crm','waitlist','analytics','analytics_export','automations','marketing','multi_location','custom_branding','deposits'], 2),
 ('enterprise', 'Enterprise', 4990, NULL, NULL, NULL, ARRAY['crm','waitlist','analytics','analytics_export','automations','marketing','multi_location','custom_branding','deposits','forecasting','api'], 3);
