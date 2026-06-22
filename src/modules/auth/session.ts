import { SignJWT, jwtVerify } from "jose";
import type { CookieOptions } from "express";

import { env } from "../../env";

// Issued-session model (D8): a signed JWT in an httpOnly cookie scoped to
// .radiia.co so apps/portal + apps/admin share it. HS256 with AUTH_SECRET —
// the same secret NextAuth used — verifiable in edge runtimes via jose, so the
// portal's edge middleware can validate without a DB round-trip.

export const SESSION_COOKIE = "radiia_session";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days (matches the prior NextAuth default)

const secretKey = new TextEncoder().encode(env.authSecret);

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "BUYER" | "ADMIN" | "STAFF";
  companyId: string | null;
};

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({
    email: user.email,
    name: user.name,
    role: user.role,
    companyId: user.companyId
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(secretKey);
}

export async function verifySession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role: payload.role === "ADMIN" ? "ADMIN" : payload.role === "STAFF" ? "STAFF" : "BUYER",
      companyId: (payload.companyId as string | null) ?? null
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SEC * 1000,
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {})
  };
}

export function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {})
  };
}
