import { hash, verify } from "@node-rs/argon2";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { prisma } from "@/db";

import { env } from "../../env";
import {
  sendPasswordResetEmail,
  sendSignupAdminNotification,
  sendSignupApplicantConfirmation
} from "../../integrations/email";
import type { SessionUser } from "./session";

const TOKEN_TTL_MS = 30 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function verifyCredentials(
  emailRaw: string,
  password: string
): Promise<SessionUser | null> {
  const email = normaliseEmail(emailRaw ?? "");
  if (!email || !password) return null;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "APPROVED") return null;

  const ok = await verify(user.passwordHash, password);
  if (!ok) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.fullName,
    role: user.role,
    companyId: user.companyId
  };
}

export type RequestPasswordResetResult = { ok: true } | { ok: false; error: string };
export type ResetPasswordResult = { ok: true } | { ok: false; error: string };

export async function requestPasswordReset(emailRaw: string): Promise<RequestPasswordResetResult> {
  const email = normaliseEmail(emailRaw ?? "");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address" };
  }

  const startedAt = Date.now();

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = await hash(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    try {
      const tokenRow = await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt }
      });

      const resetUrl = `${env.appUrl}/auth/reset-password?token=${rawToken}&id=${tokenRow.id}`;
      const firstName = user.fullName?.trim().split(/\s+/)[0] ?? "there";
      await sendPasswordResetEmail({ email: user.email, firstName, resetUrl });
    } catch {
    }
  } else {
    await hash(randomBytes(32).toString("base64url"));
  }

  const elapsed = Date.now() - startedAt;
  const floorMs = 400;
  if (elapsed < floorMs) {
    await new Promise((r) => setTimeout(r, floorMs - elapsed));
  }

  return { ok: true };
}

export type ResetPasswordInput = {
  tokenId: string;
  token: string;
  newPassword: string;
};

export async function resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
  const tokenId = String(input.tokenId ?? "").trim();
  const token = String(input.token ?? "");
  const newPassword = String(input.newPassword ?? "");

  if (!tokenId || !token) {
    return { ok: false, error: "This reset link is no longer valid" };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const tokenRow = await prisma.passwordResetToken.findUnique({ where: { id: tokenId } });
  if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "This reset link is no longer valid" };
  }

  const matches = await verify(tokenRow.tokenHash, token);
  if (!matches) {
    return { ok: false, error: "This reset link is no longer valid" };
  }
  const a = Buffer.from(tokenId);
  const b = Buffer.from(tokenRow.id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "This reset link is no longer valid" };
  }

  const passwordHash = await hash(newPassword);

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: tokenRow.userId },
        data: { passwordHash }
      }),
      prisma.passwordResetToken.update({
        where: { id: tokenRow.id },
        data: { usedAt: new Date() }
      }),
      prisma.passwordResetToken.updateMany({
        where: { userId: tokenRow.userId, usedAt: null, id: { not: tokenRow.id } },
        data: { usedAt: new Date() }
      })
    ]);
  } catch {
    return { ok: false, error: "Something went wrong. Please request a new reset link." };
  }

  return { ok: true };
}

export async function validateResetToken(tokenId: string, token: string): Promise<boolean> {
  if (!tokenId || !token) return false;
  const tokenRow = await prisma.passwordResetToken.findUnique({ where: { id: tokenId } });
  if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt.getTime() < Date.now()) return false;
  return verify(tokenRow.tokenHash, token);
}

const signupSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    companyName: z.string().trim().min(1, "Company name is required"),
    email: z
      .string()
      .trim()
      .min(1, "Email address is required")
      .email("Please enter a valid email address")
      .transform((v) => v.toLowerCase()),
    phone: z.string().trim().min(1, "Phone number is required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
    streetAddress: z.string().trim().min(1, "Street address is required"),
    city: z.string().trim().min(1, "City is required"),
    state: z.string().trim().min(1, "State is required"),
    zipCode: z.string().trim().min(1, "ZIP code is required"),
    country: z.string().trim().min(1, "Country is required"),
    referredBy: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined))
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"]
  });

export type SignupInput = z.input<typeof signupSchema>;
export type SignupResult = { ok: true; warning?: string } | { ok: false; error: string };

function joinWithAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function formatSignupIssues(issues: z.ZodIssue[]): string {
  if (issues.length === 0) return "Invalid signup data";
  const requiredLabels: string[] = [];
  const otherMessages: string[] = [];
  const seenLabels = new Set<string>();
  const seenMessages = new Set<string>();

  for (const issue of issues) {
    const match = /^(.*?)\s+is required$/i.exec(issue.message);
    if (match) {
      const label = match[1].trim();
      if (label && !seenLabels.has(label.toLowerCase())) {
        seenLabels.add(label.toLowerCase());
        requiredLabels.push(label);
      }
    } else if (!seenMessages.has(issue.message)) {
      seenMessages.add(issue.message);
      otherMessages.push(issue.message);
    }
  }

  const parts: string[] = [];
  if (requiredLabels.length > 0) {
    const verb = requiredLabels.length === 1 ? "is" : "are";
    parts.push(`${joinWithAnd(requiredLabels)} ${verb} required`);
  }
  if (otherMessages.length > 0) {
    parts.push("Please enter all required information");
  }
  return parts.join(". ");
}

export async function submitSignupRequest(input: SignupInput): Promise<SignupResult> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: formatSignupIssues(parsed.error.issues) };
  }
  const data = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    return { ok: false, error: "An account with this email already exists" };
  }

  const fullName = `${data.firstName} ${data.lastName}`.trim();
  const shippingAddress = [
    data.streetAddress,
    data.city,
    `${data.state} ${data.zipCode}`.trim(),
    data.country
  ]
    .filter(Boolean)
    .join(", ");
  const location = [data.city, data.state].filter(Boolean).join(", ");

  const passwordHash = await hash(data.password);

  try {
    await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: data.companyName,
          contactEmail: data.email,
          contactPhone: data.phone,
          shippingAddress
        }
      });
      await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          fullName,
          phone: data.phone,
          location,
          referredBy: data.referredBy ?? null,
          status: "PENDING",
          role: "BUYER",
          companyId: company.id
        }
      });
    });
  } catch {
    return { ok: false, error: "Something went wrong submitting your request. Please try again." };
  }

  const failures: string[] = [];
  try {
    await sendSignupApplicantConfirmation({ email: data.email, firstName: data.firstName });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("[submitSignupRequest] applicant confirmation email failed", err);
    failures.push(`applicant confirmation to ${data.email} (${detail})`);
  }
  try {
    await sendSignupAdminNotification({
      applicantEmail: data.email,
      applicantName: fullName,
      companyName: data.companyName
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("[submitSignupRequest] admin notification email failed", err);
    failures.push(`admin notification (${detail})`);
  }

  if (failures.length > 0) {
    return {
      ok: true,
      warning:
        `Your application was received, but the following email(s) could not be sent: ` +
        `${failures.join("; ")}. The RADIIA team has your details and will follow up.`
    };
  }
  return { ok: true };
}
