-- Comptoir POS — schema. All money is stored as integer minor units (centimes). Times are timestamptz.
-- Tenant isolation: every tenant table has org_id with FORCED Row Level Security (see bottom).

CREATE EXTENSION IF NOT EXISTS citext;

CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app_system() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('app.system', true), ''), 'off') = 'on' $$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  currency char(3) NOT NULL DEFAULT 'MAD',
  default_locale text NOT NULL DEFAULT 'fr' CHECK (default_locale IN ('fr','en','ar')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL UNIQUE,                       -- terminal code typed once on a device
  timezone text NOT NULL DEFAULT 'Africa/Casablanca',
  prices_include_tax boolean NOT NULL DEFAULT true,
  service_charge_bps integer NOT NULL DEFAULT 0 CHECK (service_charge_bps BETWEEN 0 AND 5000),
  service_charge_tax_bps integer NOT NULL DEFAULT 0 CHECK (service_charge_tax_bps BETWEEN 0 AND 5000),
  business_day_start_hour smallint NOT NULL DEFAULT 5 CHECK (business_day_start_hour BETWEEN 0 AND 12),
  idle_lock_minutes integer NOT NULL DEFAULT 15 CHECK (idle_lock_minutes BETWEEN 1 AND 480),
  table_alert_minutes integer NOT NULL DEFAULT 90 CHECK (table_alert_minutes BETWEEN 5 AND 600),
  address text, phone text,
  tax_identifier text,                              -- ICE / IF etc. — to be validated by an accountant
  receipt_header text, receipt_footer text,
  fluentra_location_id text,                        -- mapping to the Fluentra location (integration)
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  email citext,
  password_hash text,                               -- back-office login (optional)
  pin_hash text,                                    -- POS login (optional)
  role text NOT NULL CHECK (role IN ('owner','manager','supervisor','cashier','server','bartender','kitchen')),
  outlet_ids uuid[],                                -- NULL = all outlets
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX employees_email_uq ON employees(email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid REFERENCES outlets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pos','backoffice')),
  idle_timeout_min integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text
);
CREATE INDEX sessions_emp_idx ON sessions(employee_id);

CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- ───────────── Floor ─────────────
CREATE TABLE dining_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id)
);

CREATE TABLE tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  dining_room_id uuid NOT NULL,
  label text NOT NULL,
  seats integer NOT NULL DEFAULT 2 CHECK (seats BETWEEN 1 AND 60),
  x integer NOT NULL DEFAULT 0, y integer NOT NULL DEFAULT 0,
  w integer NOT NULL DEFAULT 90, h integer NOT NULL DEFAULT 90,
  shape text NOT NULL DEFAULT 'square' CHECK (shape IN ('square','round','rect')),
  assigned_server_id uuid,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (dining_room_id, org_id) REFERENCES dining_rooms(id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id),
  UNIQUE (dining_room_id, label)
);

-- ───────────── Menu ─────────────
CREATE TABLE tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (id, org_id)
);

CREATE TABLE stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('kitchen','bar','pastry')),
  target_seconds integer NOT NULL DEFAULT 600 CHECK (target_seconds BETWEEN 30 AND 7200),
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id)
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  color text,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (parent_id, org_id) REFERENCES categories(id, org_id) ON DELETE SET NULL (parent_id),
  UNIQUE (id, org_id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id uuid,
  name text NOT NULL,
  description text,
  sku text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  tax_rate_id uuid NOT NULL,
  station_kind text NOT NULL DEFAULT 'kitchen' CHECK (station_kind IN ('kitchen','bar','pastry','none')),
  default_course smallint NOT NULL DEFAULT 1 CHECK (default_course BETWEEN 1 AND 6),
  allergens text[] NOT NULL DEFAULT '{}',
  dietary text[] NOT NULL DEFAULT '{}',
  image_url text,
  available boolean NOT NULL DEFAULT true,         -- global out-of-stock switch
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (category_id, org_id) REFERENCES categories(id, org_id) ON DELETE SET NULL (category_id),
  FOREIGN KEY (tax_rate_id, org_id) REFERENCES tax_rates(id, org_id),
  UNIQUE (id, org_id)
);
CREATE INDEX products_cat_idx ON products(org_id, category_id);

-- Per-outlet availability and price override
CREATE TABLE product_outlets (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  price_cents integer CHECK (price_cents >= 0),
  available boolean NOT NULL DEFAULT true,
  hidden boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_id, outlet_id),
  FOREIGN KEY (product_id, org_id) REFERENCES products(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id) ON DELETE CASCADE
);

CREATE TABLE modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  min_select smallint NOT NULL DEFAULT 0,
  max_select smallint NOT NULL DEFAULT 1,
  CHECK (max_select >= min_select AND max_select >= 1),
  UNIQUE (id, org_id)
);
CREATE TABLE modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  name text NOT NULL,
  price_delta_cents integer NOT NULL DEFAULT 0,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (group_id, org_id) REFERENCES modifier_groups(id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id)
);
CREATE TABLE product_modifier_groups (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  group_id uuid NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id),
  FOREIGN KEY (product_id, org_id) REFERENCES products(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, org_id) REFERENCES modifier_groups(id, org_id) ON DELETE CASCADE
);

CREATE TABLE discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent','amount')),
  value integer NOT NULL CHECK (value > 0),         -- percent: basis points; amount: cents
  approval_threshold_bps integer NOT NULL DEFAULT 1000, -- percent discounts above this need a supervisor
  active boolean NOT NULL DEFAULT true,
  UNIQUE (id, org_id)
);

-- ───────────── Orders ─────────────
CREATE TABLE order_counters (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  business_date date NOT NULL,
  last_no integer NOT NULL DEFAULT 0,
  PRIMARY KEY (outlet_id, business_date)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  order_no integer NOT NULL,
  business_date date NOT NULL,
  type text NOT NULL DEFAULT 'dine_in' CHECK (type IN ('dine_in','takeaway','room_service','delivery')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','void','merged')),
  table_id uuid,
  covers integer NOT NULL DEFAULT 1 CHECK (covers BETWEEN 0 AND 200),
  server_id uuid,
  opened_by uuid,
  room_ref text,                                   -- room number / delivery reference
  note text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid,
  bill_requested_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  -- immutable financial snapshot written at close:
  gross_cents integer, item_discount_cents integer, order_discount_cents integer,
  service_charge_cents integer, tax_cents integer, total_cents integer, net_sales_cents integer, tip_cents integer NOT NULL DEFAULT 0,
  totals_snapshot jsonb,
  void_reason text,
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id),
  FOREIGN KEY (table_id, org_id) REFERENCES tables(id, org_id),
  UNIQUE (id, org_id),
  UNIQUE (outlet_id, business_date, order_no)
);
CREATE INDEX orders_open_idx ON orders(org_id, outlet_id, status);
CREATE INDEX orders_closed_idx ON orders(org_id, outlet_id, business_date) WHERE status = 'closed';
CREATE UNIQUE INDEX orders_one_open_per_table ON orders(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

-- Tables combined onto one order (the primary table is orders.table_id)
CREATE TABLE order_tables (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  table_id uuid NOT NULL,
  PRIMARY KEY (order_id, table_id),
  FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (table_id, org_id) REFERENCES tables(id, org_id)
);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  product_id uuid,
  name text NOT NULL,                               -- snapshot
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),   -- base price incl. modifiers deltas
  qty integer NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 99),
  tax_rate_bps integer NOT NULL,                    -- snapshot
  station_kind text NOT NULL DEFAULT 'kitchen',
  seat smallint,
  course smallint NOT NULL DEFAULT 1,
  hold boolean NOT NULL DEFAULT false,              -- explicit hold: not fired on send, waits for "fire"
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','held','fired','accepted','preparing','ready','served','void')),
  note text,
  allergy_note text,
  void_reason text, voided_by uuid, voided_at timestamptz, void_approved_by uuid,
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  discount_reason text, discount_approved_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),   -- insertion order within one transaction
  fired_at timestamptz, accepted_at timestamptz, started_at timestamptz, ready_at timestamptz, served_at timestamptz,
  FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, org_id) REFERENCES products(id, org_id) ON DELETE SET NULL (product_id),
  UNIQUE (id, org_id)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE INDEX order_items_kds_idx ON order_items(org_id, station_kind, status) WHERE status IN ('fired','accepted','preparing','ready');

CREATE TABLE order_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL,
  modifier_id uuid,
  name text NOT NULL,
  price_delta_cents integer NOT NULL DEFAULT 0,
  FOREIGN KEY (order_item_id, org_id) REFERENCES order_items(id, org_id) ON DELETE CASCADE
);

CREATE TABLE order_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  discount_id uuid,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent','amount')),
  value integer NOT NULL CHECK (value > 0),
  reason text NOT NULL,
  applied_by uuid, approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id) ON DELETE CASCADE
);

-- ───────────── Cash ─────────────
CREATE TABLE cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  drawer text NOT NULL DEFAULT 'Main',
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float_cents integer NOT NULL CHECK (opening_float_cents >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by uuid, closed_at timestamptz,
  counted_cash_cents integer, expected_cash_cents integer, variance_cents integer, close_note text,
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions(outlet_id, drawer) WHERE status = 'open';

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cash_session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pay_in','pay_out')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cash_session_id, org_id) REFERENCES cash_sessions(id, org_id)
);

-- ───────────── Payments ─────────────
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  order_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','card','other')),
  provider text NOT NULL,                           -- 'cash' | 'test_terminal' | real provider id
  status text NOT NULL CHECK (status IN ('pending','succeeded','declined','failed')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),   -- applied to the bill
  tip_cents integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  tendered_cents integer, change_cents integer,
  provider_ref text,
  decline_reason text,
  idempotency_key text NOT NULL,
  cash_session_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id),
  FOREIGN KEY (cash_session_id, org_id) REFERENCES cash_sessions(id, org_id),
  UNIQUE (id, org_id),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX payments_order_idx ON payments(order_id);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  provider text NOT NULL DEFAULT 'cash',
  provider_ref text,
  cash_session_id uuid,
  business_date date NOT NULL,
  created_by uuid, approved_by uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_id, org_id) REFERENCES payments(id, org_id),
  FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id),
  UNIQUE (org_id, idempotency_key)
);

CREATE TABLE day_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL,
  business_date date NOT NULL,
  closed_by uuid,
  closed_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL,
  UNIQUE (outlet_id, business_date),
  FOREIGN KEY (outlet_id, org_id) REFERENCES outlets(id, org_id)
);

-- ───────────── Audit, idempotency, integration ─────────────
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  outlet_id uuid,
  actor_id uuid,
  actor_label text,
  approver_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  order_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_logs(org_id, created_at DESC);
CREATE INDEX audit_order_idx ON audit_logs(order_id) WHERE order_id IS NOT NULL;

CREATE TABLE idempotency_keys (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  scope text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, key)
);

CREATE TABLE integration_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  adapter text NOT NULL DEFAULT 'none' CHECK (adapter IN ('none','mock','http')),
  base_url text,
  share_sales boolean NOT NULL DEFAULT true,
  share_items boolean NOT NULL DEFAULT false,
  share_refunds boolean NOT NULL DEFAULT true,
  share_kitchen boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: written in the same transaction as the business event.
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,                           -- strict insertion order (occurred_at alone ties inside one transaction)
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outlet_id uuid,
  event_key text NOT NULL,                          -- e.g. order.closed:<orderId>  (dedupes at the source)
  type text NOT NULL,
  version smallint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  delivered_at timestamptz,
  UNIQUE (org_id, event_key)
);
CREATE INDEX outbox_due_idx ON outbox_events(next_attempt_at) WHERE status = 'pending';

-- TEST ONLY: sink used by the mock Fluentra adapter (never a live integration)
CREATE TABLE mock_fluentra_inbox (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, event_id)
);

-- ───────────── Guards ─────────────
CREATE FUNCTION touch_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$;
CREATE TRIGGER orders_version BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_version();

-- Closed orders are immutable (reopen is an explicit, audited status change first).
-- Only kitchen-progress columns may still move on a closed order (e.g. quick sale paid before the kitchen is done).
CREATE FUNCTION guard_closed_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; oid uuid;
BEGIN
  oid := COALESCE(NEW.order_id, OLD.order_id);
  SELECT status INTO st FROM orders WHERE id = oid;
  IF st IN ('closed','void','merged') THEN
    IF TG_OP = 'UPDATE' AND st = 'closed'
       AND NEW.name = OLD.name AND NEW.unit_price_cents = OLD.unit_price_cents AND NEW.qty = OLD.qty
       AND NEW.tax_rate_bps = OLD.tax_rate_bps AND NEW.discount_cents = OLD.discount_cents
       AND NEW.status <> 'void' AND OLD.status <> 'void' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'order % is % and cannot be modified', oid, st USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER order_items_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_closed_order_items();

CREATE FUNCTION guard_closed_order_fin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'closed' AND
     (NEW.gross_cents IS DISTINCT FROM OLD.gross_cents OR NEW.total_cents IS DISTINCT FROM OLD.total_cents OR NEW.net_sales_cents IS DISTINCT FROM OLD.net_sales_cents OR
      NEW.tax_cents IS DISTINCT FROM OLD.tax_cents OR NEW.service_charge_cents IS DISTINCT FROM OLD.service_charge_cents OR
      NEW.order_discount_cents IS DISTINCT FROM OLD.order_discount_cents OR NEW.item_discount_cents IS DISTINCT FROM OLD.item_discount_cents) THEN
    RAISE EXCEPTION 'financial totals of a closed order are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_fin_guard BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_closed_order_fin();

-- ───────────── Row Level Security ─────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'outlets','employees','dining_rooms','tables','tax_rates','stations','categories','products','product_outlets',
    'modifier_groups','modifiers','product_modifier_groups','discounts','order_counters','orders','order_tables',
    'order_items','order_item_modifiers','order_discounts','cash_sessions','cash_movements','payments','refunds',
    'day_closes','audit_logs','idempotency_keys','integration_settings','outbox_events','mock_fluentra_inbox'])
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

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['sessions','rate_limits'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY system_only ON %I USING (app_system()) WITH CHECK (app_system())', t);
  END LOOP;
END $$;
