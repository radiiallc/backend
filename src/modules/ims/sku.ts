import type { Prisma } from "@/db";

// SKU generation (§H3.2 / §5 D5). SKUs are ours to choose (not continued from
// Fantasy). Scheme = `RAD-#####` — the `RAD-` prefix + a zero-padded monotonic
// counter, matching the seeded rows (RAD-00001, RAD-00002, …).
//
// Atomicity reuses the same DocumentSequence row-counter mechanism the document
// numbers use (§6.6 — sequences never reset / never reuse). We keep a dedicated
// key "SKU" distinct from the DocumentType keys. The counter is bumped with an
// atomic `update {increment}` so two concurrent creates can never collide; it
// must run inside the same transaction as the InventoryItem insert so a rolled-
// back create doesn't burn (and gap) a number.

const SKU_SEQUENCE_KEY = "SKU";
const SKU_PREFIX = "RAD-";
const SKU_PAD = 5;
// The seed occupies RAD-00001..00003, so start the live counter above them; the
// first generated SKU is RAD-00100. (lastValue holds the most recently issued
// numeric part; pre-seeded so `++` yields 100.)
const SKU_SEED_BASE = 99;

export function formatSku(value: number): string {
  return `${SKU_PREFIX}${String(value).padStart(SKU_PAD, "0")}`;
}

// Allocate the next SKU. MUST be called with a transaction client (tx) so the
// counter increment commits atomically with the row that uses it.
export async function nextSku(tx: Prisma.TransactionClient): Promise<string> {
  const seq = await tx.documentSequence.upsert({
    where: { type: SKU_SEQUENCE_KEY },
    // First ever allocation: create the row already advanced to the base+1 so we
    // never hand out a number the seed used.
    create: { type: SKU_SEQUENCE_KEY, lastValue: SKU_SEED_BASE + 1 },
    update: { lastValue: { increment: 1 } }
  });
  return formatSku(seq.lastValue);
}
