-- Run this in Supabase Dashboard → SQL Editor
-- Adds all columns required by the Clever HoReCa order system.
-- All statements use IF NOT EXISTS so it's safe to run multiple times.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS status           text    DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS num              text,
  ADD COLUMN IF NOT EXISTS customer_email   text,
  ADD COLUMN IF NOT EXISTS company          text,
  ADD COLUMN IF NOT EXISTS subtotal         numeric,
  ADD COLUMN IF NOT EXISTS delivery_cost    numeric,
  ADD COLUMN IF NOT EXISTS delivery_method  text    DEFAULT 'courier',
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS delivery_date    text,
  ADD COLUMN IF NOT EXISTS delivery_time    text,
  ADD COLUMN IF NOT EXISTS payment_method   text    DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS invoice_company  text,
  ADD COLUMN IF NOT EXISTS invoice_inn      text,
  ADD COLUMN IF NOT EXISTS comment          text,
  ADD COLUMN IF NOT EXISTS language         text    DEFAULT 'ru',
  ADD COLUMN IF NOT EXISTS user_id          uuid;
