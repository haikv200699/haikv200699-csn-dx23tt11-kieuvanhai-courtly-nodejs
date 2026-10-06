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
