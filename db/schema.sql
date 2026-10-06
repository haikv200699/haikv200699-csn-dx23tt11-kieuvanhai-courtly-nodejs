-- ============================================================
-- COURTLY - BADMINTON COURT BOOKING SYSTEM
-- PostgreSQL
-- ============================================================

-- ============================================================
-- 1. EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ============================================================
-- 2. ENUM TYPES
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'user_role'
    ) THEN
        CREATE TYPE user_role AS ENUM (
            'user',
            'admin',
            'staff'
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'booking_status'
    ) THEN
        CREATE TYPE booking_status AS ENUM (
            'pending',
            'confirmed',
            'cancelled'
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'payment_method'
    ) THEN
        CREATE TYPE payment_method AS ENUM (
            'onsite',
            'transfer'
        );
    END IF;
END $$;


-- ============================================================
-- 3. USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,

    email           TEXT NOT NULL UNIQUE,

    password_hash   TEXT NOT NULL,

    full_name       TEXT NOT NULL,

    phone           TEXT,

    avatar_key      TEXT NOT NULL DEFAULT ('animal-' || (floor(random() * 10)::int + 1)::text),

    role            user_role NOT NULL DEFAULT 'user',

    -- Admin quản lý thủ công; ưu đãi chỉ áp dụng cho lượt đặt mới.
    member_type     TEXT NOT NULL DEFAULT 'casual' CHECK (member_type IN ('casual','fixed')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chủ sân thiết lập tài khoản nhận chuyển khoản trong trang Quản trị.
CREATE TABLE IF NOT EXISTS payment_settings (
    id            BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    bank_bin      TEXT NOT NULL CHECK (bank_bin ~ '^[0-9]{6}$'),
    bank_name     TEXT NOT NULL,
    account_no    TEXT NOT NULL,
    account_name  TEXT NOT NULL,
    qr_image      BYTEA,
    qr_mime       TEXT CHECK (qr_mime IN ('image/png','image/jpeg','image/webp')),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- 4. COURTS
-- ============================================================

CREATE TABLE IF NOT EXISTS courts (
    id                  SERIAL PRIMARY KEY,

    name                TEXT NOT NULL UNIQUE,

    district            TEXT NOT NULL,

    type                TEXT NOT NULL DEFAULT 'standard',

    price_per_hour      INTEGER NOT NULL
                        CHECK (price_per_hour > 0),

    open_time           TIME NOT NULL DEFAULT '06:00',

    close_time          TIME NOT NULL DEFAULT '23:00',

    amenities           TEXT[] NOT NULL DEFAULT '{}',

    image_url           TEXT,

    under_maintenance   BOOLEAN NOT NULL DEFAULT false,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT court_open_close_valid
        CHECK (close_time > open_time)
);


-- ============================================================
-- 5. BOOKINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS bookings (
    id                  BIGSERIAL PRIMARY KEY,

    court_id            INTEGER NOT NULL
                        REFERENCES courts(id)
                        ON DELETE RESTRICT,

    user_id             BIGINT NOT NULL
                        REFERENCES users(id)
                        ON DELETE RESTRICT,

    starts_at           TIMESTAMPTZ NOT NULL,

    ends_at             TIMESTAMPTZ NOT NULL,

    status              booking_status NOT NULL
                        DEFAULT 'pending',

    total_price         INTEGER NOT NULL
                        CHECK (total_price > 0),

    standard_price      INTEGER CHECK (standard_price > 0),

    discount_percent    SMALLINT NOT NULL DEFAULT 0 CHECK (discount_percent IN (0, 10)),

    player_name         TEXT NOT NULL,

    player_phone        TEXT NOT NULL,

    payment_method      payment_method NOT NULL
                        DEFAULT 'onsite',

    paid                BOOLEAN NOT NULL DEFAULT false,

    -- Thời điểm hết hạn giữ chỗ pending
    hold_expires_at     TIMESTAMPTZ,

    -- Thời điểm booking được xác nhận
    confirmed_at        TIMESTAMPTZ,

    -- Thời điểm huỷ
    cancelled_at        TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- ========================================================
    -- SLOT RULES
    -- ========================================================

    CONSTRAINT booking_time_valid
        CHECK (
            ends_at > starts_at
        ),

    -- Chỉ cho phép block 30 phút
    CONSTRAINT booking_duration_valid
        CHECK (
            EXTRACT(EPOCH FROM (ends_at - starts_at)) % 1800 = 0
        ),

    -- Tối thiểu 30 phút
    CONSTRAINT booking_min_duration
        CHECK (
            ends_at - starts_at >= interval '30 minutes'
        ),

    -- Đặt mới tối đa 3 giờ; booking đã xác nhận có thể gia hạn trong ngày.
    CONSTRAINT booking_max_duration
        CHECK (
            (status = 'confirmed' AND ends_at - starts_at <= interval '1 day')
            OR (status <> 'confirmed' AND ends_at - starts_at <= interval '3 hours')
        ),

    -- Chỉ bắt đầu vào phút 00 hoặc 30
    CONSTRAINT booking_start_slot_valid
        CHECK (
            EXTRACT(MINUTE FROM starts_at) IN (0, 30)
            AND EXTRACT(SECOND FROM starts_at) = 0
        ),

    -- ========================================================
    -- PAYMENT RULES
    -- ========================================================

    -- Pending phải có thời gian hết hạn
    CONSTRAINT pending_must_have_expiration
        CHECK (
            status <> 'pending'
            OR hold_expires_at IS NOT NULL
        )
);

-- Quy tắc lặp hàng tuần của thành viên cố định (0 = Chủ nhật, 1 = Thứ 2).
CREATE TABLE IF NOT EXISTS weekly_schedules (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
    weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_min SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1410 AND start_min % 30 = 0),
    end_min SMALLINT NOT NULL CHECK (end_min BETWEEN 30 AND 1440 AND end_min % 30 = 0),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_min > start_min AND end_min - start_min <= 180)
);
CREATE INDEX IF NOT EXISTS weekly_schedules_active_idx ON weekly_schedules (user_id) WHERE active;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS schedule_rule_id BIGINT REFERENCES weekly_schedules(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS schedule_date DATE;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_schedule_occurrence_idx ON bookings (schedule_rule_id, schedule_date) WHERE schedule_rule_id IS NOT NULL;


-- Dịch vụ phát sinh được lưu riêng; total_price trong bookings là tiền sân gốc.
CREATE TABLE IF NOT EXISTS booking_addons (
    id          BIGSERIAL PRIMARY KEY,
    booking_id  BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('product', 'extra_time')),
    label       TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
    quantity    INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    unit_price  INTEGER NOT NULL CHECK (unit_price BETWEEN 1 AND 100000000),
    paid        BOOLEAN NOT NULL DEFAULT false,
    created_by  BIGINT REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_addons_booking_idx ON booking_addons(booking_id);


-- ============================================================
-- 6. PREVENT DOUBLE BOOKING
-- ============================================================
--
-- Pending và confirmed đều chiếm slot.
--
-- [) nghĩa:
--
-- 19:00 -> 20:00
-- 20:00 -> 21:00
--
-- được phép đứng cạnh nhau.
--
-- Nhưng:
--
-- 19:00 -> 20:00
-- 19:30 -> 20:30
--
-- sẽ bị chặn.
--
-- ============================================================

ALTER TABLE bookings
DROP CONSTRAINT IF EXISTS no_overlap;

ALTER TABLE bookings
ADD CONSTRAINT no_overlap
EXCLUDE USING gist (
    court_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
)
WHERE (
    status IN ('pending', 'confirmed')
);


-- ============================================================
-- 7. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS bookings_user_idx
ON bookings (
    user_id,
    starts_at DESC
);

CREATE INDEX IF NOT EXISTS bookings_member_rank_idx
ON bookings (user_id, ends_at DESC)
WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_court_time_idx
ON bookings (
    court_id,
    starts_at
);

CREATE INDEX IF NOT EXISTS bookings_status_idx
ON bookings (
    status
);

CREATE INDEX IF NOT EXISTS bookings_hold_expiry_idx
ON bookings (
    hold_expires_at
)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS bookings_transfer_deadline_idx
ON bookings (confirmed_at)
WHERE status = 'confirmed' AND payment_method = 'transfer' AND paid = false;

CREATE INDEX IF NOT EXISTS bookings_active_idx
ON bookings (
    court_id,
    starts_at,
    ends_at
)
WHERE status IN ('pending', 'confirmed');


-- ============================================================
-- Pricing tables, quote function and invoice views
-- Idempotent migration: preserve every existing booking amount and tariff snapshot.
CREATE TABLE IF NOT EXISTS pricing_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
  config JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pricing_settings(id, config) VALUES (true, '{"weekday":[{"start":300,"end":1020,"casual":60000,"fixed":50000},{"start":1020,"end":1200,"casual":100000,"fixed":80000},{"start":1200,"end":1440,"casual":80000,"fixed":70000}],"weekend":[{"start":300,"end":900,"casual":80000,"fixed":70000},{"start":900,"end":1200,"casual":100000,"fixed":80000},{"start":1200,"end":1440,"casual":80000,"fixed":70000}],"holidays":[]}') ON CONFLICT(id) DO NOTHING;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_discount_type TEXT NOT NULL DEFAULT 'amount' CHECK(invoice_discount_type IN ('amount','percent'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_discount_value INTEGER NOT NULL DEFAULT 0 CHECK(invoice_discount_value >= 0 AND (invoice_discount_type <> 'percent' OR invoice_discount_value <= 100));

CREATE OR REPLACE FUNCTION court_price_quote(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_member TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE cfg JSONB; r JSONB; at_time TIMESTAMPTZ; local_time TIMESTAMP; minute INTEGER; grp TEXT;
  amount INTEGER; standard INTEGER := 0; total INTEGER := 0; rate INTEGER; lines JSONB := '[]';
  member TEXT := CASE WHEN p_member='fixed' THEN 'fixed' ELSE 'casual' END;
BEGIN
  IF p_end <= p_start OR p_end-p_start > interval '1 day' OR
     extract(epoch FROM p_end-p_start)::numeric % 1800 <> 0 OR extract(epoch FROM p_start)::numeric % 1800 <> 0 THEN
    RAISE EXCEPTION 'Thời gian phải theo ca 30 phút';
  END IF;
  SELECT config INTO STRICT cfg FROM pricing_settings WHERE id=true;
  at_time := p_start;
  WHILE at_time < p_end LOOP
    local_time := at_time AT TIME ZONE 'Asia/Ho_Chi_Minh';
    minute := extract(hour FROM local_time)::int*60 + extract(minute FROM local_time)::int;
    grp := CASE WHEN extract(dow FROM local_time) IN (0,6) OR cfg->'holidays' ? to_char(local_time,'YYYY-MM-DD') THEN 'weekend' ELSE 'weekday' END;
    SELECT x INTO r FROM jsonb_array_elements(cfg->grp) x WHERE minute >= (x->>'start')::int AND minute < (x->>'end')::int;
    IF r IS NULL THEN RAISE EXCEPTION 'Thời gian này chưa có bảng giá'; END IF;
    rate := (r->>member)::int; amount := round(rate/2.0);
    total := total + amount; standard := standard + round((r->>'casual')::int/2.0);
    lines := lines || jsonb_build_array(jsonb_build_object('startsAt',at_time,'endsAt',at_time+interval '30 minutes','rate',rate,'amount',amount,'group',grp));
    at_time := at_time + interval '30 minutes';
  END LOOP;
  RETURN jsonb_build_object('total',total,'standard',standard,'memberType',member,'lines',lines);
END $$;

-- Discounts apply to each line. Amount discounts are allocated rent first, then services by ID.
-- Percentage discounts are rounded to a whole VND per line; later services use the same percentage.
CREATE OR REPLACE VIEW booking_charge_lines AS
WITH raw AS (
  SELECT b.id booking_id, 0::bigint line_id, b.total_price::bigint gross, b.paid,
    b.invoice_discount_type kind, b.invoice_discount_value value FROM bookings b
  UNION ALL
  SELECT a.booking_id, a.id, a.quantity::bigint*a.unit_price, a.paid, b.invoice_discount_type, b.invoice_discount_value
  FROM booking_addons a JOIN bookings b ON b.id=a.booking_id
), allocated AS (
  SELECT *, CASE WHEN kind='percent' THEN round(gross*value/100.0)::bigint
    ELSE least(gross, greatest(0, value-coalesce(sum(gross) OVER (PARTITION BY booking_id ORDER BY line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))::bigint END discount
  FROM raw
)
SELECT booking_id, line_id, gross, discount, gross-discount net, paid FROM allocated;
CREATE OR REPLACE VIEW booking_invoice_totals AS
SELECT booking_id, sum(gross)::bigint subtotal, sum(discount)::bigint discount,
  sum(net)::bigint total, coalesce(sum(net) FILTER (WHERE paid),0)::bigint paid_amount
FROM booking_charge_lines GROUP BY booking_id;

-- 8. UPDATED_AT FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 9. UPDATED_AT TRIGGERS
-- ============================================================

DROP TRIGGER IF EXISTS users_updated_at_trg
ON users;

CREATE TRIGGER users_updated_at_trg
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


DROP TRIGGER IF EXISTS courts_updated_at_trg
ON courts;

CREATE TRIGGER courts_updated_at_trg
BEFORE UPDATE ON courts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


DROP TRIGGER IF EXISTS bookings_updated_at_trg
ON bookings;

CREATE TRIGGER bookings_updated_at_trg
BEFORE UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 10. PAYMENT TRIGGER (gỡ quy tắc cũ: chuyển khoản không đồng nghĩa đã thu tiền)
-- ============================================================
DROP TRIGGER IF EXISTS bookings_payment_rules_trg ON bookings;
DROP FUNCTION IF EXISTS bookings_payment_rules();


-- ============================================================
-- 11. BOOKING STATUS TIMESTAMP TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION bookings_status_timestamps()
RETURNS TRIGGER AS $$
BEGIN

    -- Confirmed
    IF NEW.status = 'confirmed'
       AND OLD.status IS DISTINCT FROM 'confirmed' THEN

        NEW.confirmed_at := COALESCE(
            NEW.confirmed_at,
            now()
        );

        NEW.hold_expires_at := NULL;

    END IF;


    -- Cancelled
    IF NEW.status = 'cancelled'
       AND OLD.status IS DISTINCT FROM 'cancelled' THEN

        NEW.cancelled_at := COALESCE(
            NEW.cancelled_at,
            now()
        );

    END IF;


    RETURN NEW;

END;
$$ LANGUAGE plpgsql;


DROP TRIGGER IF EXISTS bookings_status_timestamps_trg
ON bookings;

CREATE TRIGGER bookings_status_timestamps_trg
BEFORE UPDATE
ON bookings
FOR EACH ROW
EXECUTE FUNCTION bookings_status_timestamps();


-- ============================================================
-- 12. CREATE BOOKING FUNCTION
-- ============================================================
--
-- Dùng khi user chọn slot.
--
-- Booking mới sẽ:
--
-- pending
-- hold 5 phút
--
-- ============================================================

CREATE OR REPLACE FUNCTION create_booking(
    p_court_id INTEGER,
    p_user_id BIGINT,
    p_starts_at TIMESTAMPTZ,
    p_ends_at TIMESTAMPTZ,
    p_player_name TEXT,
    p_player_phone TEXT,
    p_payment_method payment_method
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE

    v_price INTEGER;

    v_standard_price INTEGER;

    v_discount SMALLINT;

    v_booking_id BIGINT;

    v_duration_hours NUMERIC;
    v_quote JSONB;
    v_member TEXT;

BEGIN

    -- ========================================================
    -- CHECK COURT
    -- ========================================================

    SELECT price_per_hour
    INTO v_price
    FROM courts
    WHERE id = p_court_id
      AND under_maintenance = false;

    IF v_price IS NULL THEN
        RAISE EXCEPTION
            'Court không tồn tại hoặc đang bảo trì';
    END IF;

    SELECT CASE WHEN role = 'user' THEN member_type ELSE 'casual' END
    INTO v_member FROM users WHERE id = p_user_id;
    v_discount := 0;


    -- ========================================================
    -- VALIDATE SLOT
    -- ========================================================

    IF p_ends_at <= p_starts_at THEN
        RAISE EXCEPTION
            'Thời gian kết thúc phải lớn hơn thời gian bắt đầu';
    END IF;


    IF EXTRACT(
        EPOCH FROM (p_ends_at - p_starts_at)
    ) % 1800 <> 0 THEN

        RAISE EXCEPTION
            'Thời lượng phải theo block 30 phút';

    END IF;


    IF p_ends_at - p_starts_at > interval '3 hours' THEN

        RAISE EXCEPTION
            'Thời lượng tối đa là 3 giờ';

    END IF;


    IF EXTRACT(
        MINUTE FROM p_starts_at
    ) NOT IN (0, 30) THEN

        RAISE EXCEPTION
            'Giờ bắt đầu phải là phút 00 hoặc 30';

    END IF;


    -- ========================================================
    -- CALCULATE PRICE
    -- ========================================================

    v_duration_hours :=
        EXTRACT(
            EPOCH FROM (p_ends_at - p_starts_at)
        ) / 3600;

    -- Giá theo 30 phút
    v_quote := court_price_quote(p_starts_at, p_ends_at, v_member);
    v_standard_price := (v_quote->>'standard')::int;
    v_price := (v_quote->>'total')::int;


    -- ========================================================
    -- INSERT
    -- ========================================================

    INSERT INTO bookings (
        court_id,
        user_id,
        starts_at,
        ends_at,
        status,
        total_price,
        standard_price,
        discount_percent,
        pricing_snapshot,
        player_name,
        player_phone,
        payment_method,
        paid,
        hold_expires_at
    )
    VALUES (
        p_court_id,
        p_user_id,
        p_starts_at,
        p_ends_at,
        'pending',
        v_price,
        v_standard_price,
        v_discount,
        v_quote,
        p_player_name,
        p_player_phone,
        p_payment_method,
        false,
        now() + interval '5 minutes'
    )
    RETURNING id INTO v_booking_id;


    RETURN v_booking_id;


EXCEPTION

    WHEN exclusion_violation THEN

        RAISE EXCEPTION
            'Khung giờ này vừa được người khác giữ hoặc đặt';

END;
$$;


-- ============================================================
-- 13. CONFIRM BOOKING
-- ============================================================

CREATE OR REPLACE FUNCTION confirm_booking(
    p_booking_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN

    UPDATE bookings
    SET
        status = 'confirmed',
        confirmed_at = now(),
        hold_expires_at = NULL
    WHERE id = p_booking_id
      AND status = 'pending'
      AND (
          hold_expires_at IS NULL
          OR hold_expires_at > now()
      );

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Booking không tồn tại, đã hết hạn hoặc không còn ở trạng thái pending';

    END IF;

END;
$$;


-- ============================================================
-- 14. CANCEL BOOKING
-- ============================================================

CREATE OR REPLACE FUNCTION cancel_booking(
    p_booking_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN

    UPDATE bookings
    SET
        status = 'cancelled',
        cancelled_at = now()
    WHERE id = p_booking_id
      AND status = 'confirmed';

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Booking không tồn tại hoặc chưa được xác nhận hoặc đã được huỷ';

    END IF;

END;
$$;


-- ============================================================
-- 15. AUTO EXPIRE PENDING BOOKINGS
-- ============================================================
--
-- Chạy định kỳ bằng cron / backend scheduler.
--
-- pending quá 5 phút => xóa giữ chỗ, không ghi nhận là hủy booking
--
-- ============================================================

CREATE OR REPLACE FUNCTION expire_pending_bookings()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE

    v_count INTEGER;

BEGIN

    DELETE FROM bookings
    WHERE status = 'pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= now();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;

END;
$$;


-- ============================================================
-- 16. COURT LIVE STATUS
-- ============================================================

CREATE OR REPLACE VIEW court_live_status AS

SELECT

    c.id AS court_id,

    c.name,

    c.district,

    c.price_per_hour,

    c.image_url,

    c.amenities,

    CASE

        WHEN c.under_maintenance THEN
            'MAINTENANCE'

        WHEN EXISTS (
            SELECT 1
            FROM bookings b
            WHERE b.court_id = c.id

              AND b.status = 'confirmed'

              AND now() >= b.starts_at

              AND now() < b.ends_at
        ) THEN
            'PLAYING'

        WHEN EXISTS (
            SELECT 1
            FROM bookings b
            WHERE b.court_id = c.id

              AND b.status IN ('pending', 'confirmed')

              AND b.starts_at > now()

              AND b.starts_at < now() + interval '2 hours'

              AND (
                  b.status = 'confirmed'
                  OR b.hold_expires_at > now()
              )
        ) THEN
            'RESERVED'

        ELSE
            'AVAILABLE'

    END AS status,


    (
        SELECT MIN(b.starts_at)

        FROM bookings b

        WHERE b.court_id = c.id

          AND b.status IN ('pending', 'confirmed')

          AND b.ends_at > now()

          AND (
              b.status = 'confirmed'
              OR b.hold_expires_at > now()
          )

    ) AS next_start

FROM courts c;


-- ============================================================
-- 17. AVAILABLE SLOTS
-- ============================================================
--
-- Trả về các slot 30 phút trong một ngày.
--
-- Backend có thể dùng view/function này để render calendar.
--
-- ============================================================

CREATE OR REPLACE FUNCTION get_available_slots(
    p_court_id INTEGER,
    p_date DATE
)
RETURNS TABLE (
    slot_start TIMESTAMPTZ,
    slot_end TIMESTAMPTZ,
    available BOOLEAN
)
LANGUAGE sql
AS $$

WITH court_info AS (

    SELECT
        id,
        open_time,
        close_time
    FROM courts
    WHERE id = p_court_id
      AND under_maintenance = false

),

slots AS (

    SELECT
        gs AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AS slot_start

    FROM court_info ci,

    generate_series(
        p_date::timestamp + ci.open_time,
        p_date::timestamp + ci.close_time - interval '30 minutes',
        interval '30 minutes'
    ) gs

)

SELECT

    s.slot_start,

    s.slot_start + interval '30 minutes'
        AS slot_end,

    NOT EXISTS (

        SELECT 1

        FROM bookings b

        WHERE b.court_id = p_court_id

          AND b.status IN ('pending', 'confirmed')

          AND tstzrange(
              b.starts_at,
              b.ends_at,
              '[)'
          )
          &&
          tstzrange(
              s.slot_start,
              s.slot_start + interval '30 minutes',
              '[)'
          )

          AND (
              b.status = 'confirmed'
              OR b.hold_expires_at > now()
          )

    ) AS available

FROM slots s

ORDER BY s.slot_start;

$$;


-- ============================================================
-- ============================================================
-- 18. SAMPLE USERS
-- ============================================================
--
-- Không seed password/hash giả trong schema.
-- Development tạo dữ liệu demo; production chỉ tạo admin từ biến môi trường.
--

-- 20. TEST QUERIES
-- ============================================================

-- Xem trạng thái realtime
--
-- SELECT *
-- FROM court_live_status;


-- Xem slot Court 01 ngày hôm nay
--
-- SELECT *
-- FROM get_available_slots(
--     1,
--     CURRENT_DATE
-- );


-- Tạo booking giữ chỗ 5 phút
--
-- SELECT create_booking(
--     1,
--     2,
--     '2026-09-25 19:00:00+07',
--     '2026-09-25 20:00:00+07',
--     'Nguyễn Văn A',
--     '0901234567',
--     'onsite'
-- );


-- Xác nhận booking
--
-- SELECT confirm_booking(1);


-- Huỷ booking
--
-- SELECT cancel_booking(1);


-- Xoá các pending đã hết hạn
--
-- SELECT expire_pending_bookings();
