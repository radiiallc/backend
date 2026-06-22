-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('STONE', 'JEWELRY', 'OTHER_MATERIAL');

-- CreateEnum
CREATE TYPE "ItemSubtype" AS ENUM ('SINGLE', 'PAIR', 'PARCEL');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('IN_STOCK', 'ON_MEMO', 'ON_CONSIGNMENT', 'SOLD', 'RETURNED');

-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('IN_STOCK', 'ON_MEMO', 'ON_CONSIGNMENT', 'SOLD', 'RETURNED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('BILL_IN', 'MEMO_IN', 'BRAND_INVENTORY_IN', 'MEMO_OUT', 'CONSIGNMENT_OUT', 'INVOICE', 'PURCHASE_ORDER', 'RETURN_MEMO_OUT', 'RETURN_MEMO_IN', 'BRAND_INVENTORY_OUT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPORTED', 'BILLED', 'VOID');

-- CreateEnum
CREATE TYPE "CertLab" AS ENUM ('GIA', 'IGI', 'NONE');

-- CreateEnum
CREATE TYPE "StoneType" AS ENUM ('NATURAL', 'LAB');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'STAFF';

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "itemType" "ItemType" NOT NULL,
    "itemSubtype" "ItemSubtype",
    "status" "ItemStatus" NOT NULL DEFAULT 'IN_STOCK',
    "vendorId" TEXT,
    "brandOwnerId" TEXT,
    "visibleOnPortal" BOOLEAN NOT NULL DEFAULT false,
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
    "shape" TEXT,
    "weightCt" DECIMAL(10,3),
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
    "lab" "CertLab" NOT NULL DEFAULT 'NONE',
    "certNumber" TEXT,
    "certUrl" TEXT,
    "naturalOrLab" "StoneType",
    "origin" TEXT,
    "treatment" TEXT,
    "wholesalePricePerCt" DECIMAL(12,2),
    "costPerCt" DECIMAL(12,2),
    "totalWholesalePrice" DECIMAL(12,2),
    "totalCost" DECIMAL(12,2),
    "photo1Url" TEXT,
    "photo2Url" TEXT,
    "videoUrl" TEXT,

    CONSTRAINT "StoneDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JewelryDetail" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "brand" TEXT,
    "jewelryItemType" TEXT,
    "metal" TEXT,
    "ringSize" TEXT,
    "lengthMm" DECIMAL(10,3),
    "productionCost" DECIMAL(12,2),
    "wholesalePrice" DECIMAL(12,2),
    "retailPrice" DECIMAL(12,2),
    "description" TEXT,
    "certNumber" TEXT,

    CONSTRAINT "JewelryDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtherMaterialDetail" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "category" TEXT,
    "materialType" TEXT,
    "metal" TEXT,
    "cost" DECIMAL(12,2),
    "dateIn" TIMESTAMP(3),
    "lengthMm" DECIMAL(10,3),
    "otherSpecs" TEXT,

    CONSTRAINT "OtherMaterialDetail_pkey" PRIMARY KEY ("id")
);

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
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "address" TEXT,
    "creditLimit" DECIMAL(12,2),
    "defaultTermsDays" INTEGER,
    "quickbooksId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientUser" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'OPEN',
    "clientId" TEXT,
    "vendorId" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "projectJob" TEXT,
    "discountAmount" DECIMAL(12,2),
    "notes" TEXT,
    "emailedAt" TIMESTAMP(3),
    "qboSyncedAt" TIMESTAMP(3),
    "qboReferenceId" TEXT,
    "linkedPoId" TEXT,
    "billedPoId" TEXT,
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
    "notes" TEXT,

    CONSTRAINT "ItemStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "type" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("type")
);

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
CREATE INDEX "InventoryItem_visibleOnPortal_idx" ON "InventoryItem"("visibleOnPortal");

-- CreateIndex
CREATE UNIQUE INDEX "StoneDetail_inventoryItemId_key" ON "StoneDetail"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "JewelryDetail_inventoryItemId_key" ON "JewelryDetail"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "OtherMaterialDetail_inventoryItemId_key" ON "OtherMaterialDetail"("inventoryItemId");

-- CreateIndex
CREATE INDEX "ClientUser_userId_idx" ON "ClientUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientUser_clientId_userId_key" ON "ClientUser"("clientId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_documentNumber_key" ON "Document"("documentNumber");

-- CreateIndex
CREATE INDEX "Document_type_status_idx" ON "Document"("type", "status");

-- CreateIndex
CREATE INDEX "Document_clientId_idx" ON "Document"("clientId");

-- CreateIndex
CREATE INDEX "Document_vendorId_idx" ON "Document"("vendorId");

-- CreateIndex
CREATE INDEX "Document_dueDate_idx" ON "Document"("dueDate");

-- CreateIndex
CREATE INDEX "DocumentLineItem_documentId_idx" ON "DocumentLineItem"("documentId");

-- CreateIndex
CREATE INDEX "DocumentLineItem_inventoryItemId_idx" ON "DocumentLineItem"("inventoryItemId");

-- CreateIndex
CREATE INDEX "ItemStatusHistory_inventoryItemId_idx" ON "ItemStatusHistory"("inventoryItemId");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_brandOwnerId_fkey" FOREIGN KEY ("brandOwnerId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoneDetail" ADD CONSTRAINT "StoneDetail_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JewelryDetail" ADD CONSTRAINT "JewelryDetail_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherMaterialDetail" ADD CONSTRAINT "OtherMaterialDetail_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientUser" ADD CONSTRAINT "ClientUser_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientUser" ADD CONSTRAINT "ClientUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_linkedPoId_fkey" FOREIGN KEY ("linkedPoId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_billedPoId_fkey" FOREIGN KEY ("billedPoId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

