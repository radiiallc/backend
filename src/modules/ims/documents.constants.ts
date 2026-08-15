import type { DocumentType, ItemStatus, LineStatus, PartyKind } from "@/contract";

const INBOUND_TYPES: readonly DocumentType[] = ["MEMO_IN", "BILL_IN", "BRAND_INVENTORY_IN"];

export function docDirectionOf(type: DocumentType): "in" | "out" {
  return INBOUND_TYPES.includes(type) ? "in" : "out";
}

export const DOC_PREFIX: Record<DocumentType, string> = {
  MEMO_OUT: "MEM",
  INVOICE: "INV",
  PURCHASE_ORDER: "PO",
  BRAND_INVENTORY_IN: "BIN",
  BRAND_INVENTORY_OUT: "BOU",
  MEMO_IN: "MIN",
  BILL_IN: "BIL",
  RETURN_MEMO_OUT: "RET",
  RETURN_MEMO_IN: "RET"
};

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

const CLIENT_PARTY_TYPES: readonly DocumentType[] = [
  "MEMO_OUT",
  "INVOICE",
  "RETURN_MEMO_OUT",
  "BRAND_INVENTORY_IN",
  "BRAND_INVENTORY_OUT"
];

export function partyKindOf(type: DocumentType): PartyKind {
  return CLIENT_PARTY_TYPES.includes(type) ? "client" : "vendor";
}

export type OutboundCreateType = "MEMO_OUT" | "INVOICE" | "BRAND_INVENTORY_OUT";

export const NEW_ITEM_STATUS: Record<OutboundCreateType, ItemStatus> = {
  MEMO_OUT: "ON_MEMO",
  INVOICE: "SOLD",
  BRAND_INVENTORY_OUT: "RETURNED"
};

export const NEW_LINE_STATUS: Record<OutboundCreateType, LineStatus> = {
  MEMO_OUT: "ON_MEMO",
  INVOICE: "SOLD",
  BRAND_INVENTORY_OUT: "RETURNED"
};

export const ALLOWED_SOURCE_STATUS: Record<OutboundCreateType, ItemStatus[]> = {
  MEMO_OUT: ["IN_STOCK", "RESERVED"],
  INVOICE: ["IN_STOCK", "RESERVED", "ON_MEMO"],
  BRAND_INVENTORY_OUT: ["IN_STOCK"]
};
