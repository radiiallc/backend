import type { DocumentType, ItemStatus, LineStatus, PartyKind } from "@/contract";

// Document semantics shared by the read mapper and the write service. These
// mirror the admin mock (the requirements source of truth): docDir, prefixFor,
// and the saveNd/convertReq status transitions in admin/src/lib/AppStore.ts.

// Inbound docs (create/receive inventory). Everything else is outbound.
const INBOUND_TYPES: readonly DocumentType[] = ["MEMO_IN", "BILL_IN", "BRAND_INVENTORY_IN"];

export function docDirectionOf(type: DocumentType): "in" | "out" {
  return INBOUND_TYPES.includes(type) ? "in" : "out";
}

// Number prefix per type (admin prefixFor). Inbound BILL_IN / MEMO_IN carry the
// vendor's own number in externalReference and never draw a sequence, but the
// prefix is defined for completeness.
export const DOC_PREFIX: Record<DocumentType, string> = {
  MEMO_OUT: "MEM",
  INVOICE: "INV",
  PURCHASE_ORDER: "PO",
  BRAND_INVENTORY_IN: "BIN",
  BRAND_INVENTORY_OUT: "BOU", // distinct prefix so BIN-#### stays unique to Brand In
  MEMO_IN: "MIN",
  BILL_IN: "BIL",
  RETURN_MEMO_OUT: "RET",
  RETURN_MEMO_IN: "RET"
};

// How each type is NAMED to the operator. Refusal messages are shown verbatim
// in a toast, so the enum token must never reach one — "a BILL_IN cannot be
// voided" is not a sentence anybody should read.
export const DOC_LABEL: Record<DocumentType, string> = {
  MEMO_OUT: "Memo Out",
  INVOICE: "Invoice",
  PURCHASE_ORDER: "Purchase Order",
  BRAND_INVENTORY_IN: "Brand In",
  BRAND_INVENTORY_OUT: "Brand Out",
  MEMO_IN: "Memo In",
  BILL_IN: "Bill In",
  RETURN_MEMO_OUT: "Return Memo Out",
  RETURN_MEMO_IN: "Return Memo In"
};

// Which party a doc addresses (used only as a fallback; the read mapper prefers
// deriving from whichever FK is actually set). Client-addressed vs vendor-addressed.
const CLIENT_PARTY_TYPES: readonly DocumentType[] = [
  "MEMO_OUT",
  "INVOICE",
  "RETURN_MEMO_OUT",
  "RETURN_MEMO_IN",
  "BRAND_INVENTORY_IN",
  "BRAND_INVENTORY_OUT"
];

export function partyKindOf(type: DocumentType): PartyKind {
  return CLIENT_PARTY_TYPES.includes(type) ? "client" : "vendor";
}

// ── Outbound create transitions (admin saveNd / convertReq) ──────────────────
// The two outbound types this first write slice supports and the item status
// each one moves its lines to.
export type OutboundCreateType = "MEMO_OUT" | "INVOICE";

export const NEW_ITEM_STATUS: Record<OutboundCreateType, ItemStatus> = {
  MEMO_OUT: "ON_MEMO",
  INVOICE: "SOLD"
};

export const NEW_LINE_STATUS: Record<OutboundCreateType, LineStatus> = {
  MEMO_OUT: "ON_MEMO",
  INVOICE: "SOLD"
};

// A line can only be added to a new outbound doc from these source statuses.
// MEMO_OUT holds a free stone; INVOICE sells from stock OR converts an on-memo
// stone to a sale. SOLD / RETURNED items are never re-drawn.
export const ALLOWED_SOURCE_STATUS: Record<OutboundCreateType, ItemStatus[]> = {
  MEMO_OUT: ["IN_STOCK", "RESERVED"],
  INVOICE: ["IN_STOCK", "RESERVED", "ON_MEMO"]
};
