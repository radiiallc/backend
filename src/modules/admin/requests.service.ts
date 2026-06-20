import { prisma } from "@/db";
import { formatRequestReference } from "@/domain";
import type { AdminActionResult } from "@/contract";

import { sendRequestReviewSummaryEmail, type RequestReviewItem } from "../../integrations/email";

// Port of the portal admin request actions. requireAdmin() + revalidatePath are
// handled at the route layer; item status transitions, the overall-status
// derivation, the pending-items guard, and the review-summary email are
// unchanged.

export async function approveRequestItem(itemId: string): Promise<AdminActionResult> {
  if (!itemId) return { ok: false, error: "Missing itemId" };
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status: "APPROVED" },
    include: { request: true }
  });
  return { ok: true };
}

export async function rejectRequestItem(itemId: string): Promise<AdminActionResult> {
  if (!itemId) return { ok: false, error: "Missing itemId" };
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status: "REJECTED" },
    include: { request: true }
  });
  return { ok: true };
}

export async function setRequestItemPending(itemId: string): Promise<AdminActionResult> {
  if (!itemId) return { ok: false, error: "Missing itemId" };
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status: "PENDING" }
  });
  return { ok: true };
}

export async function updateRequestExternalNote(
  requestId: string,
  externalNote: string
): Promise<AdminActionResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };
  await prisma.request.update({
    where: { id: requestId },
    data: { externalNote: externalNote ?? "" }
  });
  return { ok: true };
}

export async function completeRequestReview(requestId: string): Promise<AdminActionResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { items: true, user: true }
  });
  if (!request) return { ok: false, error: "Request not found" };

  const pendingCount = request.items.filter((i) => i.status === "PENDING").length;
  if (pendingCount > 0) {
    return {
      ok: false,
      error: `Cannot complete review while ${pendingCount} item${pendingCount === 1 ? "" : "s"} still pending.`
    };
  }

  const approvedCount = request.items.filter((i) => i.status === "APPROVED").length;
  const rejectedCount = request.items.filter((i) => i.status === "REJECTED").length;

  let overall: "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED";
  if (approvedCount === request.items.length) overall = "APPROVED";
  else if (rejectedCount === request.items.length) overall = "REJECTED";
  else overall = "PARTIALLY_APPROVED";

  await prisma.request.update({
    where: { id: requestId },
    data: { status: overall, reviewedAt: new Date() }
  });

  const summaryItems: RequestReviewItem[] = request.items.map((it) => {
    const payload = (it.snapshotPayload ?? {}) as Record<string, unknown>;
    const variety =
      (typeof payload.variety === "string" && payload.variety) ||
      (typeof payload.varietyRaw === "string" && payload.varietyRaw) ||
      it.snapshotSku;
    const shape =
      (typeof payload.shape === "string" && payload.shape) ||
      (typeof payload.shapeRaw === "string" && payload.shapeRaw) ||
      null;
    const weightCtRaw =
      typeof payload.weightCt === "number"
        ? payload.weightCt
        : typeof payload.carat === "number"
          ? payload.carat
          : null;
    return {
      sku: it.snapshotSku,
      varietyOrName: variety as string,
      shape,
      weightCt: weightCtRaw,
      outcome: it.status === "APPROVED" ? "APPROVED" : "REJECTED",
      totalPriceUsd: Number(it.snapshotPriceUsd.toString())
    };
  });

  // Gate §7 — emails are fail-loud-but-non-blocking: the review status is already
  // committed above, so an email failure must surface a warning, never abort the
  // completed review (mirrors approveAccount / submitRequest).
  let warning: string | undefined;
  try {
    const firstName = request.user.fullName.trim().split(/\s+/)[0] ?? request.user.fullName;
    await sendRequestReviewSummaryEmail({
      email: request.user.email,
      firstName,
      reference: formatRequestReference(request.seq),
      type: request.type,
      overallStatus: overall,
      items: summaryItems,
      externalNote: request.externalNote ?? ""
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("[completeRequestReview] review summary email failed", err);
    warning =
      `Review completed, but the outcome email to ${request.user.email} could not be sent: ${detail}. ` +
      `Verify your RESEND_API_KEY and that the RESEND_FROM_EMAIL domain is verified in Resend.`;
  }

  return warning ? { ok: true, warning } : { ok: true };
}
