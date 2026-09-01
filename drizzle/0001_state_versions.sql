ALTER TABLE application_states
ADD COLUMN version TEXT NOT NULL DEFAULT '';

ALTER TABLE application_states
ADD COLUMN deleted_at TEXT;
