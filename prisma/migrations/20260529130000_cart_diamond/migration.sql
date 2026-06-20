-- AlterTable: allow diamond cart items
ALTER TABLE "CartItem" ALTER COLUMN "gemstoneId" DROP NOT NULL;
ALTER TABLE "CartItem" ADD COLUMN "diamondId" TEXT;

-- CreateIndex
CREATE INDEX "CartItem_diamondId_idx" ON "CartItem"("diamondId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_diamondId_key" ON "CartItem"("cartId", "diamondId");

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_diamondId_fkey" FOREIGN KEY ("diamondId") REFERENCES "Diamond"("id") ON DELETE CASCADE ON UPDATE CASCADE;
