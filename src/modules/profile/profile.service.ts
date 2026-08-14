import { hash, verify } from "@node-rs/argon2";

import { prisma } from "@/db";
import type {
  BuyerProfile,
  ChangePasswordBody,
  ProfileActionResult,
  UpdateBuyerProfileBody
} from "@/contract";

const MIN_PASSWORD_LENGTH = 8;

export async function getBuyerProfile(userId: string): Promise<BuyerProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: true }
  });
  if (!user) return null;
  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone ?? "",
    location: user.location ?? "",
    company: {
      id: user.company?.id ?? null,
      name: user.company?.name ?? "",
      shippingAddress: user.company?.shippingAddress ?? ""
    }
  };
}

export async function updateBuyerProfile(
  userId: string,
  input: UpdateBuyerProfileBody
): Promise<ProfileActionResult> {
  const phone = String(input.phone ?? "").trim();

  await prisma.user.update({
    where: { id: userId },
    data: { phone: phone || null }
  });

  return { ok: true };
}

export async function updateBuyerCompanyAddress(
  userId: string,
  shippingAddress: string
): Promise<ProfileActionResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { companyId: true }
  });
  if (!user?.companyId) {
    return { ok: false, error: "No company on file. Contact your administrator." };
  }

  const address = String(shippingAddress ?? "").trim();

  await prisma.company.update({
    where: { id: user.companyId },
    data: { shippingAddress: address || null }
  });

  return { ok: true };
}

export async function changePassword(
  userId: string,
  input: ChangePasswordBody
): Promise<ProfileActionResult> {
  const currentPassword = String(input.currentPassword ?? "");
  const newPassword = String(input.newPassword ?? "");
  if (!currentPassword) {
    return { ok: false, error: "Please enter your current password" };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true }
  });
  if (!user) return { ok: false, error: "Not authorized" };

  const matches = await verify(user.passwordHash, currentPassword);
  if (!matches) {
    return { ok: false, error: "Current password is incorrect" };
  }

  const passwordHash = await hash(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash }
  });

  return { ok: true };
}
