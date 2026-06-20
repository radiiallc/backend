import type {
  Company as PrismaCompany,
  Request as PrismaRequest,
  RequestItem as PrismaRequestItem,
  RequestStatus as PrismaRequestStatus,
  User as PrismaUser
} from "@/db";
import { formatRequestReference } from "@/domain";
import type {
  AdminAccount,
  AdminAccountStatus,
  AdminCompany,
  AdminItemCategory,
  AdminRequest,
  AdminRequestItem,
  AdminRequestItemStatus,
  AdminRequestStatus
} from "@/contract";

export function prismaCompanyToAdminCompany(c: PrismaCompany): AdminCompany {
  return {
    id: c.id,
    name: c.name,
    shippingAddress: c.shippingAddress ?? "",
    gemstoneMarkupPct: decimalToNumberOrNull(c.gemstoneMarkupPct),
    naturalDiamondMarkupPct: decimalToNumberOrNull(c.naturalDiamondMarkupPct),
    labDiamondMarkupPct: decimalToNumberOrNull(c.labDiamondMarkupPct),
    internalNotes: c.internalNotes ?? ""
  };
}

export function prismaUserToAdminAccount(u: PrismaUser): AdminAccount {
  const [firstName, ...rest] = (u.fullName ?? "").trim().split(/\s+/);
  return {
    id: u.id,
    firstName: firstName ?? "",
    lastName: rest.join(" "),
    email: u.email,
    phone: u.phone ?? "",
    location: u.location ?? "",
    referredBy: u.referredBy,
    status: userStatusToAccountStatus(u.status),
    signedUpAt: u.createdAt.toISOString(),
    activeSince: u.approvedAt?.toISOString() ?? null,
    companyId: u.companyId ?? ""
  };
}

export function prismaRequestToAdminRequest(
  r: PrismaRequest & { items: PrismaRequestItem[] }
): AdminRequest {
  return {
    id: r.id,
    reference: formatRequestReference(r.seq),
    type: r.type,
    status: requestStatusToAdmin(r.status),
    companyId: r.companyId,
    submittedByAccountId: r.userId,
    submittedAt: r.submittedAt.toISOString(),
    noteFromClient: r.note,
    externalNote: r.externalNote ?? "",
    items: r.items.map(prismaRequestItemToAdminRequestItem)
  };
}

export function prismaRequestItemToAdminRequestItem(item: PrismaRequestItem): AdminRequestItem {
  const payload = (item.snapshotPayload ?? {}) as Record<string, unknown>;
  const variety = stringFromPayload(payload, "variety", "varietyRaw");
  const shape = stringFromPayload(payload, "shape", "shapeRaw");
  const color = stringFromPayload(payload, "color", "colorRaw");
  const carat = numberFromPayload(payload, "carat", "weightCt");
  const markupPct = numberFromPayload(payload, "markupPct") ?? 0;
  const markupFactor = 1 + markupPct / 100;
  const rawPerCarat = numberFromPayload(payload, "pricePerCarat", "basePricePerCtUsd");
  const pricePerCarat =
    numberFromPayload(payload, "displayPricePerCtUsd") ??
    (rawPerCarat === null ? null : Math.round(rawPerCarat * markupFactor * 100) / 100);
  const totalPrice = decimalToNumber(item.snapshotPriceUsd);
  return {
    id: item.id,
    sku: item.snapshotSku,
    category: (stringFromPayload(payload, "category") as AdminItemCategory) ?? "gemstone",
    variety: variety ?? "",
    shape: shape ?? "",
    carat: carat ?? 0,
    color: color ?? "",
    clarity: stringFromPayload(payload, "clarity"),
    certNumber: stringFromPayload(payload, "certNumber"),
    vendor: stringFromPayload(payload, "vendor") ?? resolveVendorFallback(payload),
    pricePerCarat: pricePerCarat ?? 0,
    totalPrice,
    status: itemStatusToAdmin(item.status)
  };
}

function userStatusToAccountStatus(s: PrismaUser["status"]): AdminAccountStatus {
  switch (s) {
    case "PENDING":
      return "PENDING";
    case "APPROVED":
      return "ACTIVE";
    case "DECLINED":
      return "DECLINED";
    case "DEACTIVATED":
      return "DEACTIVATED";
  }
}

function requestStatusToAdmin(s: PrismaRequestStatus): AdminRequestStatus {
  switch (s) {
    case "PENDING":
    case "UNDER_REVIEW":
      return "PENDING";
    case "APPROVED":
      return "APPROVED";
    case "PARTIALLY_APPROVED":
      return "PARTIAL";
    case "REJECTED":
      return "REJECTED";
  }
}

function itemStatusToAdmin(s: PrismaRequestItem["status"]): AdminRequestItemStatus {
  switch (s) {
    case "PENDING":
      return "UNDECIDED";
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
  }
}

function decimalToNumberOrNull(value: PrismaCompany["gemstoneMarkupPct"] | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

function decimalToNumber(value: PrismaRequestItem["snapshotPriceUsd"]): number {
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

// Older request snapshots predate the stored `vendor` key. Derive it from the
// data they do carry: gemstones come from the Fantasy GEMSSTOCK feed (RADIIA),
// diamonds map 1:1 — Lab → Skylab, Natural → Disons.
function resolveVendorFallback(payload: Record<string, unknown>): string {
  if (stringFromPayload(payload, "category") === "diamond") {
    const origin = stringFromPayload(payload, "origin");
    return origin === "Lab" ? "Skylab" : "Disons";
  }
  return "RADIIA";
}

function stringFromPayload(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function numberFromPayload(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
