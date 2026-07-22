/*
  Warnings:

  - You are about to drop the column `itemName` on the `JewelryDetail` table. All the data in the column will be lost.
  - You are about to drop the column `itemName` on the `OtherMaterialDetail` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('RETURNED', 'SOLD', 'MIXED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "clientStatus" "ClientStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "defaultInvoiceTermsDays" INTEGER,
ADD COLUMN     "defaultMemoTermsDays" INTEGER,
ADD COLUMN     "quickbooksId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "closeReason" "CloseReason",
ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "parentDocumentId" TEXT,
ADD COLUMN     "quickbooksSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DocumentLineItem" ADD COLUMN     "resolvedByDocumentId" TEXT;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "itemName" TEXT;

-- AlterTable
ALTER TABLE "JewelryDetail" DROP COLUMN "itemName",
ALTER COLUMN "quantity" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "OtherMaterialDetail" DROP COLUMN "itemName",
ALTER COLUMN "category" DROP NOT NULL,
ALTER COLUMN "quantity" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "defaultInvoiceTermsDays" INTEGER;

-- CreateIndex
CREATE INDEX "Company_clientStatus_idx" ON "Company"("clientStatus");

-- CreateIndex
CREATE INDEX "Document_parentDocumentId_idx" ON "Document"("parentDocumentId");

-- CreateIndex
CREATE INDEX "DocumentLineItem_resolvedByDocumentId_idx" ON "DocumentLineItem"("resolvedByDocumentId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentDocumentId_fkey" FOREIGN KEY ("parentDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLineItem" ADD CONSTRAINT "DocumentLineItem_resolvedByDocumentId_fkey" FOREIGN KEY ("resolvedByDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
