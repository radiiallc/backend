import type { DocumentType, Prisma } from "@/db";

// ────────────────────────────────────────────────────────────────────────────
// Document-number allocation (§6.6 / gate §6.16 — sequences never reset, never
// reuse). Reuses the same DocumentSequence row-counter mechanism as SKUs, keyed
// by the DocumentType value.
//
// Numbering scheme locked with Jennifer 2026-06-23 ([[project-ims-requirements-
// 2026-06-23]]): START FRESH (not Fantasy's numbers); start at 1000, increment
// by 3 (→ 1003, 1006, 1009…), distinct letter prefix per type.
//
//   ┌──────────────────────┬────────┬───────────────────────────────────┐
//   │ DocumentType          │ prefix │ origin                            │
//   ├──────────────────────┼────────┼───────────────────────────────────┤
//   │ INVOICE               │ INV-   │ ✅ confirmed (Jennifer)            │
//   │ MEMO_OUT              │ MEM-   │ ✅ confirmed (Jennifer)            │
//   │ CONSIGNMENT_OUT       │ CON-   │ provisional (H6)                  │
//   │ PURCHASE_ORDER        │ PO-    │ provisional (H6)                  │
//   │ RETURN_MEMO_OUT       │ RMO-   │ provisional (H7)                  │
//   │ RETURN_MEMO_IN        │ RMI-   │ provisional (H7)                  │
//   │ BRAND_INVENTORY_OUT   │ BIO-   │ provisional (H7)                  │
//   └──────────────────────┴────────┴───────────────────────────────────┘
//
// Inbound docs (BILL_IN / MEMO_IN / BRAND_INVENTORY_IN) get NO number here — the
// vendor supplies their own, stored on Document.externalReference ("not ours to
// assign" — Jennifer 2026-06-23). They are intentionally absent from PREFIXES.
// ────────────────────────────────────────────────────────────────────────────

const DOC_NUMBER_BASE = 1000;
const DOC_NUMBER_STEP = 3;

// Only the document types WE originate appear here. Absence = no generated
// number (inbound types use the vendor's own reference instead).
export const DOC_NUMBER_PREFIXES: Partial<Record<DocumentType, string>> = {
  INVOICE: "INV-",
  MEMO_OUT: "MEM-",
  CONSIGNMENT_OUT: "CON-",
  PURCHASE_ORDER: "PO-",
  RETURN_MEMO_OUT: "RMO-",
  RETURN_MEMO_IN: "RMI-",
  BRAND_INVENTORY_OUT: "BIO-"
};

export function assignsDocumentNumber(type: DocumentType): boolean {
  return type in DOC_NUMBER_PREFIXES;
}

// Allocate the next document number for a type WE originate. MUST be called with
// a transaction client so the counter increment commits atomically with the
// Document insert (a rolled-back create must not burn — and gap — a number).
// Throws if called for an inbound type (no prefix) — a programming error.
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  type: DocumentType
): Promise<string> {
  const prefix = DOC_NUMBER_PREFIXES[type];
  if (!prefix) {
    throw new Error(`nextDocumentNumber: ${type} does not get a generated number`);
  }
  const seq = await tx.documentSequence.upsert({
    where: { type },
    // First ever allocation for this type: base + step (→ 1003).
    create: { type, lastValue: DOC_NUMBER_BASE + DOC_NUMBER_STEP },
    update: { lastValue: { increment: DOC_NUMBER_STEP } }
  });
  return `${prefix}${seq.lastValue}`;
}
