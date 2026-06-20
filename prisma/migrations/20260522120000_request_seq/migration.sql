-- Add nullable seq column
ALTER TABLE "Request" ADD COLUMN "seq" INTEGER;

-- Create sequence backing the column
CREATE SEQUENCE "Request_seq_seq" START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- Backfill existing rows in submission order so old requests get the earliest seq values
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "submittedAt" ASC, "id" ASC) AS rn
  FROM "Request"
)
UPDATE "Request" r
SET "seq" = ordered.rn
FROM ordered
WHERE r.id = ordered.id;

-- Advance sequence so the next nextval() returns max(seq) + 1
SELECT setval(
  '"Request_seq_seq"',
  GREATEST(COALESCE((SELECT MAX("seq") FROM "Request"), 0), 1),
  true
);

-- Wire up default + NOT NULL + ownership
ALTER TABLE "Request" ALTER COLUMN "seq" SET DEFAULT nextval('"Request_seq_seq"');
ALTER TABLE "Request" ALTER COLUMN "seq" SET NOT NULL;
ALTER SEQUENCE "Request_seq_seq" OWNED BY "Request"."seq";

-- Unique constraint
CREATE UNIQUE INDEX "Request_seq_key" ON "Request"("seq");
