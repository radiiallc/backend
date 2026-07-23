-- H9 request conversion (#0035) + substitute (#0038). Both columns are additive
-- and nullable, so this is a safe append-only migration (no backfill needed).

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "convertedDocumentId" TEXT;

-- AlterTable
ALTER TABLE "RequestItem" ADD COLUMN     "substituteInventoryItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Request_convertedDocumentId_key" ON "Request"("convertedDocumentId");

-- CreateIndex
CREATE INDEX "RequestItem_substituteInventoryItemId_idx" ON "RequestItem"("substituteInventoryItemId");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_convertedDocumentId_fkey" FOREIGN KEY ("convertedDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestItem" ADD CONSTRAINT "RequestItem_substituteInventoryItemId_fkey" FOREIGN KEY ("substituteInventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
