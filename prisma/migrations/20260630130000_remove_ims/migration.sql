-- Remove in-house IMS (reverse of 20260622140000_ims_foundation).
--
-- The IMS / admin-shell work (Phase H1–H4) was rolled back so that prod and the
-- backend's main line carry only the live client portal; IMS development restarts
-- from a clean baseline. All 11 IMS tables were verified EMPTY in prod on
-- 2026-06-30 (0 rows each), so this drops no data.
--
-- DROP ... CASCADE removes the IMS-side foreign keys; the portal "User" table is
-- referenced BY these tables (not the other way around), so it is untouched.

-- DropTable (children first; CASCADE handles remaining FKs)
DROP TABLE IF EXISTS "ItemStatusHistory" CASCADE;
DROP TABLE IF EXISTS "DocumentLineItem" CASCADE;
DROP TABLE IF EXISTS "Document" CASCADE;
DROP TABLE IF EXISTS "StoneDetail" CASCADE;
DROP TABLE IF EXISTS "JewelryDetail" CASCADE;
DROP TABLE IF EXISTS "OtherMaterialDetail" CASCADE;
DROP TABLE IF EXISTS "ClientUser" CASCADE;
DROP TABLE IF EXISTS "InventoryItem" CASCADE;
DROP TABLE IF EXISTS "Vendor" CASCADE;
DROP TABLE IF EXISTS "Client" CASCADE;
DROP TABLE IF EXISTS "DocumentSequence" CASCADE;

-- DropEnum
DROP TYPE IF EXISTS "ItemType";
DROP TYPE IF EXISTS "ItemSubtype";
DROP TYPE IF EXISTS "ItemStatus";
DROP TYPE IF EXISTS "LineStatus";
DROP TYPE IF EXISTS "DocumentType";
DROP TYPE IF EXISTS "DocumentStatus";
DROP TYPE IF EXISTS "CertLab";
DROP TYPE IF EXISTS "StoneType";
DROP TYPE IF EXISTS "OtherMaterialSubtype";

-- AlterEnum: remove the 'STAFF' value added by the IMS migration. Postgres cannot
-- drop a value from an enum in place, so recreate the type. No user holds 'STAFF'
-- (verified 2026-06-30), so the cast below cannot fail.
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('BUYER', 'ADMIN');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole" USING ("role"::text::"UserRole");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'BUYER';
DROP TYPE "UserRole_old";
