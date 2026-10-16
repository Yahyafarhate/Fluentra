-- Decor drawn on a floor plan (pool, walls, doors, bar…). Pool, basin and wall are obstacles: tables on either side are never grouped together.
CREATE TABLE floor_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  floor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pool','basin','wall','door','bar','stage','plant','stairs','label')),
  label text,
  x integer NOT NULL DEFAULT 20 CHECK (x BETWEEN 0 AND 5000),
  y integer NOT NULL DEFAULT 20 CHECK (y BETWEEN 0 AND 5000),
  w integer NOT NULL DEFAULT 120 CHECK (w BETWEEN 6 AND 3000),
  h integer NOT NULL DEFAULT 80 CHECK (h BETWEEN 6 AND 3000),
  rotation integer NOT NULL DEFAULT 0 CHECK (rotation BETWEEN 0 AND 359),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (floor_id, org_id) REFERENCES floors(id, org_id) ON DELETE CASCADE
);
CREATE INDEX floor_items_loc_idx ON floor_items(location_id);
ALTER TABLE floor_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE floor_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON floor_items USING (app_system() OR org_id = app_org()) WITH CHECK (app_system() OR org_id = app_org());
