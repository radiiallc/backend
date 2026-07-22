-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('STONE', 'JEWELRY', 'OTHER_MATERIAL');

-- CreateEnum
CREATE TYPE "ItemSubtype" AS ENUM ('SINGLE', 'PAIR', 'PARCEL');

-- CreateEnum
CREATE TYPE "StoneType" AS ENUM ('NATURAL', 'LAB');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'ON_MEMO', 'SOLD', 'RETURNED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('BILL_IN', 'MEMO_IN', 'BRAND_INVENTORY_IN', 'MEMO_OUT', 'INVOICE', 'PURCHASE_ORDER', 'RETURN_MEMO_OUT', 'RETURN_MEMO_IN', 'BRAND_INVENTORY_OUT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPORTED', 'BILLED', 'VOID');

-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('IN_STOCK', 'ON_MEMO', 'SOLD', 'RETURNED');

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "address" TEXT,
    "defaultMemoTermsDays" INTEGER,
    "quickbooksId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "vendorSku" TEXT,
    "itemType" "ItemType" NOT NULL,
    "itemSubtype" "ItemSubtype",
    "status" "ItemStatus" NOT NULL DEFAULT 'IN_STOCK',
    "vendorId" TEXT,
    "brandOwnerId" TEXT,
    "reservedForClientId" TEXT,
    "reservedAt" TIMESTAMP(3),
    "visibleOnPortal" BOOLEAN NOT NULL DEFAULT false,
    "enteredStockAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoneDetail" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "gemType" TEXT,
    "naturalOrLab" "StoneType",
    "shape" TEXT NOT NULL,
    "weightCt" DECIMAL(10,3) NOT NULL,
    "quantity" INTEGER,
    "color" TEXT,
    "fancyColor" TEXT,
    "fancyIntensity" TEXT,
    "fancyOvertone" TEXT,
    "clarity" TEXT,
    "cutGrade" TEXT,
    "polish" TEXT,
    "symmetry" TEXT,
    "fluorescence" TEXT,
    "lengthMm" DECIMAL(10,3),
    "widthMm" DECIMAL(10,3),
    "heightMm" DECIMAL(10,3),
    "depthPct" DECIMAL(6,2),
    "tablePct" DECIMAL(6,2),
    "girdle" TEXT,
    "ratio" DECIMAL(10,4),
    "lab" TEXT,
    "certNumber" TEXT,
    "certUrl" TEXT,
    "origin" TEXT,
    "treatment" TEXT,
    "costPerCt" DECIMAL(12,2),
    "wholesalePricePerCt" DECIMAL(12,2),
    "totalCost" DECIMAL(12,2),
    "totalWholesalePrice" DECIMAL(12,2),
    "photo1Url" TEXT,
    "photo2Url" TEXT,
    "videoUrl" TEXT,

    CONSTRAINT "StoneDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JewelryDetail" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "jewelryItemType" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "metal" TEXT NOT NULL,
    "lengthMm" DECIMAL(10,3),
    "ringSize" TEXT,
    "mm" DECIMAL(10,3),
    "metalWeightGrams" DECIMAL(10,3),
    "productionCost" DECIMAL(12,2) NOT NULL,
    "wholesalePrice" DECIMAL(12,2),
    "retailPrice" DECIMAL(12,2),
    "brand" TEXT,
    "certNumber" TEXT,
    "photo1Url" TEXT,
    "photo2Url" TEXT,
    "videoUrl" TEXT,

    CONSTRAINT "JewelryDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtherMaterialDetail" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subtype" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "metalType" TEXT NOT NULL,
    "lengthMm" DECIMAL(10,3),
    "size" TEXT,
    "mm" DECIMAL(10,3),
    "weightGrams" DECIMAL(10,3),
    "description" TEXT,
    "cost" DECIMAL(12,2) NOT NULL,
    "wholesalePrice" DECIMAL(12,2),
    "photo1Url" TEXT,
    "photo2Url" TEXT,
    "videoUrl" TEXT,

    CONSTRAINT "OtherMaterialDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "documentNumber" TEXT,
    "externalReference" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'OPEN',
    "vendorId" TEXT,
    "clientId" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "discountAmount" DECIMAL(12,2),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLineItem" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "lineStatus" "LineStatus" NOT NULL,
    "quantity" INTEGER,
    "caratWeight" DECIMAL(10,3),
    "unitPrice" DECIMAL(12,2),
    "totalPrice" DECIMAL(12,2),
    "discountAmount" DECIMAL(12,2),
    "clientReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemStatusHistory" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "previousStatus" "ItemStatus",
    "newStatus" "ItemStatus" NOT NULL,
    "documentId" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "type" "DocumentType" NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 1000,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("type")
);

-- CreateTable
CREATE TABLE "VocabularyValue" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VocabularyValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE INDEX "Vendor_name_idx" ON "Vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_sku_key" ON "InventoryItem"("sku");

-- CreateIndex
CREATE INDEX "InventoryItem_status_idx" ON "InventoryItem"("status");

-- CreateIndex
CREATE INDEX "InventoryItem_itemType_idx" ON "InventoryItem"("itemType");

-- CreateIndex
CREATE INDEX "InventoryItem_vendorId_idx" ON "InventoryItem"("vendorId");

-- CreateIndex
CREATE INDEX "InventoryItem_brandOwnerId_idx" ON "InventoryItem"("brandOwnerId");

-- CreateIndex
CREATE INDEX "InventoryItem_reservedForClientId_idx" ON "InventoryItem"("reservedForClientId");

-- CreateIndex
CREATE INDEX "InventoryItem_visibleOnPortal_idx" ON "InventoryItem"("visibleOnPortal");

-- CreateIndex
CREATE INDEX "InventoryItem_vendorSku_idx" ON "InventoryItem"("vendorSku");

-- CreateIndex
CREATE UNIQUE INDEX "StoneDetail_inventoryItemId_key" ON "StoneDetail"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "JewelryDetail_inventoryItemId_key" ON "JewelryDetail"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "OtherMaterialDetail_inventoryItemId_key" ON "OtherMaterialDetail"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_documentNumber_key" ON "Document"("documentNumber");

-- CreateIndex
CREATE INDEX "Document_type_idx" ON "Document"("type");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Document_vendorId_idx" ON "Document"("vendorId");

-- CreateIndex
CREATE INDEX "Document_clientId_idx" ON "Document"("clientId");

-- CreateIndex
CREATE INDEX "Document_externalReference_idx" ON "Document"("externalReference");

-- CreateIndex
CREATE INDEX "DocumentLineItem_documentId_idx" ON "DocumentLineItem"("documentId");

-- CreateIndex
CREATE INDEX "DocumentLineItem_inventoryItemId_idx" ON "DocumentLineItem"("inventoryItemId");

-- CreateIndex
CREATE INDEX "ItemStatusHistory_inventoryItemId_idx" ON "ItemStatusHistory"("inventoryItemId");

-- CreateIndex
CREATE INDEX "ItemStatusHistory_documentId_idx" ON "ItemStatusHistory"("documentId");

-- CreateIndex
CREATE INDEX "VocabularyValue_kind_idx" ON "VocabularyValue"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyValue_kind_value_key" ON "VocabularyValue"("kind", "value");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_brandOwnerId_fkey" FOREIGN KEY ("brandOwnerId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_reservedForClientId_fkey" FOREIGN KEY ("reservedForClientId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoneDetail" ADD CONSTRAINT "StoneDetail_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JewelryDetail" ADD CONSTRAINT "JewelryDetail_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherMaterialDetail" ADD CONSTRAINT "OtherMaterialDetail_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLineItem" ADD CONSTRAINT "DocumentLineItem_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLineItem" ADD CONSTRAINT "DocumentLineItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemStatusHistory" ADD CONSTRAINT "ItemStatusHistory_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemStatusHistory" ADD CONSTRAINT "ItemStatusHistory_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemStatusHistory" ADD CONSTRAINT "ItemStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
