import { z } from "zod";

export const BuyerProfileSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  company: z.object({
    id: z.string().nullable(),
    name: z.string(),
    shippingAddress: z.string()
  })
});
export type BuyerProfile = z.infer<typeof BuyerProfileSchema>;

export type ProfileActionResult = { ok: true } | { ok: false; error: string };

export const UpdateBuyerProfileBodySchema = z.object({ phone: z.string() });
export type UpdateBuyerProfileBody = z.infer<typeof UpdateBuyerProfileBodySchema>;

export const UpdateCompanyAddressBodySchema = z.object({ shippingAddress: z.string() });
export type UpdateCompanyAddressBody = z.infer<typeof UpdateCompanyAddressBodySchema>;

export const ChangePasswordBodySchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string()
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;
