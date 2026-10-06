-- Idempotent migration. Existing staff accounts receive the documented default permissions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_permissions jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_discount_max_percent integer NOT NULL DEFAULT 5 CHECK (staff_discount_max_percent BETWEEN 0 AND 100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_discount_max_amount integer NOT NULL DEFAULT 20000 CHECK (staff_discount_max_amount >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS operation_audit (
  id bigserial PRIMARY KEY, actor_id bigint REFERENCES users(id) ON DELETE SET NULL,
  actor_name text NOT NULL, actor_role text NOT NULL, action text NOT NULL,
  entity_id bigint, reason text NOT NULL DEFAULT '', before_data jsonb, after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operation_audit_recent ON operation_audit(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS discount_requests (
  id bigserial PRIMARY KEY, booking_id bigint NOT NULL REFERENCES bookings(id),
  requested_by bigint NOT NULL REFERENCES users(id), discount_type text NOT NULL CHECK (discount_type IN ('amount','percent')),
  discount_value integer NOT NULL CHECK (discount_value >= 0), reason text NOT NULL,
  fingerprint text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by bigint REFERENCES users(id), review_reason text, created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_discount_per_booking ON discount_requests(booking_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS bookings_placed_at_idx ON bookings ((COALESCE(confirmed_at,created_at)) DESC,id DESC);
