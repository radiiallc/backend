import { prisma } from "@/db";
import type { AdminActionResult, MarkupUpdateBody } from "@/contract";

import { sendAccountApprovalEmail, sendAccountDeclineEmail } from "../../integrations/email";

// Port of the portal admin account actions. requireAdmin() + revalidatePath are
// handled at the route layer (requireAdmin middleware); validation, status
// transitions, and approval/decline emails are unchanged.

export async function approveAccount(userId: string): Promise<AdminActionResult> {
  if (!userId) return { ok: false, error: "Missing userId" };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, error: "User not found" };
  if (user.role !== "BUYER") return { ok: false, error: "Only buyer accounts can be approved" };

  await prisma.user.update({
    where: { id: userId },
    data: { status: "APPROVED", approvedAt: new Date() }
  });

  let warning: string | undefined;
  try {
    const firstName = user.fullName.trim().split(/\s+/)[0] ?? user.fullName;
    await sendAccountApprovalEmail({ email: user.email, firstName });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("[approveAccount] approval email failed", err);
    warning =
      `Account approved, but the confirmation email to ${user.email} could not be sent: ${detail}. ` +
      `Verify your RESEND_API_KEY and that the RESEND_FROM_EMAIL domain is verified in Resend.`;
  }

  return warning ? { ok: true, warning } : { ok: true };
}

export async function declineAccount(
  userId: string,
  reason?: string | null
): Promise<AdminActionResult> {
  if (!userId) return { ok: false, error: "Missing userId" };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, error: "User not found" };

  await prisma.user.update({
    where: { id: userId },
    data: { status: "DECLINED" }
  });

  let warning: string | undefined;
  try {
    await sendAccountDeclineEmail({
      email: user.email,
      fullName: user.fullName,
      reason: reason ?? null
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("[declineAccount] decline email failed", err);
    warning =
      `Account declined, but the notification email to ${user.email} could not be sent: ${detail}.`;
  }

  return warning ? { ok: true, warning } : { ok: true };
}

export async function reactivateAccount(userId: string): Promise<AdminActionResult> {
  if (!userId) return { ok: false, error: "Missing userId" };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, error: "User not found" };
  if (user.status !== "DEACTIVATED") {
    return { ok: false, error: "Only deactivated accounts can be reactivated" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { status: "APPROVED" }
  });

  return { ok: true };
}

export async function deactivateAccount(userId: string): Promise<AdminActionResult> {
  if (!userId) return { ok: false, error: "Missing userId" };

  await prisma.user.update({
    where: { id: userId },
    data: { status: "DEACTIVATED" }
  });

  return { ok: true };
}

export async function updateCompanyMarkups(
  companyId: string,
  markups: MarkupUpdateBody
): Promise<AdminActionResult> {
  if (!companyId) return { ok: false, error: "Missing companyId" };

  for (const value of Object.values(markups)) {
    if (value !== null && (Number.isNaN(value) || value < 0 || value > 1000)) {
      return { ok: false, error: "Markup must be between 0 and 1000" };
    }
  }

  await prisma.company.update({
    where: { id: companyId },
    data: {
      gemstoneMarkupPct: markups.gemstoneMarkupPct ?? 0,
      naturalDiamondMarkupPct: markups.naturalDiamondMarkupPct ?? 0,
      labDiamondMarkupPct: markups.labDiamondMarkupPct ?? 0
    }
  });

  return { ok: true };
}

export async function updateCompanyInternalNotes(
  companyId: string,
  internalNotes: string
): Promise<AdminActionResult> {
  if (!companyId) return { ok: false, error: "Missing companyId" };

  await prisma.company.update({
    where: { id: companyId },
    data: { internalNotes: internalNotes ?? "" }
  });

  return { ok: true };
}
