-- Credit limit ($ amount) per client account/company. Additive, NOT NULL with a
-- default so existing rows backfill to 0 — a metadata-only change on Postgres
-- (non-volatile default), no table rewrite.
ALTER TABLE "Company" ADD COLUMN "creditLimitUsd" DECIMAL(12, 2) NOT NULL DEFAULT 0;
