-- A guest booked a party larger than any single table and accepted that tables are put together; staff must validate it.
ALTER TABLE reservations ADD COLUMN grouping_accepted boolean NOT NULL DEFAULT false;
