-- AlterTable
ALTER TABLE "Company" ADD COLUMN "internalNotes" TEXT NOT NULL DEFAULT '',
ADD COLUMN "shippingAddress" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "location" TEXT,
ADD COLUMN "referredBy" TEXT;
