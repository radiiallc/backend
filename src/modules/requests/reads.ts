import { Prisma, prisma } from "@/db";
import { formatRequestReference } from "@/domain";
import type {
  BuyerRequestDetail,
  BuyerRequestDetailItem,
  BuyerRequestListItem
} from "@/contract";

export async function listRequestsForBuyer(userId: string): Promise<BuyerRequestListItem[]> {
  const rows = await prisma.request.findMany({
    where: { userId },
    orderBy: { submittedAt: "desc" },
    include: {
      items: { select: { snapshotPriceUsd: true } }
    }
  });
  return rows.map((r) => ({
    id: r.id,
    reference: formatRequestReference(r.seq),
    type: r.type,
    status: r.status,
    submittedAt: r.submittedAt.toISOString(),
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    itemCount: r.items.length,
    totalUsd:
      Math.round(
        r.items.reduce((sum, it) => sum + Number(it.snapshotPriceUsd), 0) * 100
      ) / 100
  }));
}

type SnapshotPayload = {
  qty?: number;
  unitDisplayPriceUsd?: number | null;
  varietyRaw?: string | null;
  shapeRaw?: string | null;
  colorRaw?: string | null;
  weightCt?: number | null;
  certLab?: string | null;
  certNumber?: string | null;
  origin?: string | null;
  treatment?: string | null;
};

function readSnapshot(json: Prisma.JsonValue): SnapshotPayload {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as SnapshotPayload;
  }
  return {};
}

export async function getRequestForBuyer(
  userId: string,
  requestId: string
): Promise<BuyerRequestDetail | null> {
  const row = await prisma.request.findUnique({
    where: { id: requestId },
    include: {
      items: true,
      company: { select: { name: true, shippingAddress: true } }
    }
  });
  if (!row) return null;
  if (row.userId !== userId) return null;

  const items: BuyerRequestDetailItem[] = row.items.map((it) => {
    const snap = readSnapshot(it.snapshotPayload);
    const totalPriceUsd = Number(it.snapshotPriceUsd);
    return {
      id: it.id,
      sku: it.snapshotSku,
      status: it.status,
      qty: typeof snap.qty === "number" ? snap.qty : 1,
      unitPriceUsd:
        typeof snap.unitDisplayPriceUsd === "number" ? snap.unitDisplayPriceUsd : null,
      totalPriceUsd,
      variety: snap.varietyRaw ?? "",
      shape: snap.shapeRaw ?? "",
      color: snap.colorRaw ?? "",
      weightCt: typeof snap.weightCt === "number" ? snap.weightCt : null,
      certLab: snap.certLab ?? null,
      certNumber: snap.certNumber ?? null,
      origin: snap.origin ?? null,
      treatment: snap.treatment ?? null
    };
  });

  const totalUsd =
    Math.round(items.reduce((s, it) => s + it.totalPriceUsd, 0) * 100) / 100;
  const approvedTotalUsd =
    Math.round(
      items.filter((it) => it.status === "APPROVED").reduce((s, it) => s + it.totalPriceUsd, 0) *
        100
    ) / 100;

  return {
    id: row.id,
    reference: formatRequestReference(row.seq),
    type: row.type,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    note: row.note,
    externalNote: row.externalNote?.trim() ? row.externalNote : null,
    totalUsd,
    approvedTotalUsd,
    items,
    company: {
      name: row.company?.name ?? "",
      shippingAddress: row.company?.shippingAddress ?? ""
    }
  };
}
