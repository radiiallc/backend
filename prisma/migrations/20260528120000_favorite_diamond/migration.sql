-- AlterTable: allow diamond favorites
ALTER TABLE "Favorite" ALTER COLUMN "gemstoneId" DROP NOT NULL;
ALTER TABLE "Favorite" ADD COLUMN "diamondId" TEXT;

-- CreateIndex
CREATE INDEX "Favorite_diamondId_idx" ON "Favorite"("diamondId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_diamondId_key" ON "Favorite"("userId", "diamondId");

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_diamondId_fkey" FOREIGN KEY ("diamondId") REFERENCES "Diamond"("id") ON DELETE CASCADE ON UPDATE CASCADE;
