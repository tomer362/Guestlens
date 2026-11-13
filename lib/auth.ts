import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const GUEST_COOKIE = "gl_guest";
const ADMIN_COOKIE = "gl_admin";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

function key() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export interface GuestClaims { gid: string; eid: string; }
export interface AdminClaims { eid: string; admin: true; }

async function sign(payload: Record<string, unknown>, maxAge: number) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .sign(key());
}

async function verify<T>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return payload as T;
  } catch {
    return null;
  }
}

const cookieOpts = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

export async function setGuestCookie(c: GuestClaims) {
  (await cookies()).set(GUEST_COOKIE, await sign({ ...c }, THIRTY_DAYS), cookieOpts(THIRTY_DAYS));
}
export async function getGuest(): Promise<GuestClaims | null> {
  return verify<GuestClaims>((await cookies()).get(GUEST_COOKIE)?.value);
}
export async function setAdminCookie(c: { eid: string }) {
  const age = 60 * 60 * 12;
  (await cookies()).set(ADMIN_COOKIE, await sign({ ...c, admin: true }, age), cookieOpts(age));
}
export async function getAdmin(): Promise<AdminClaims | null> {
  const a = await verify<AdminClaims>((await cookies()).get(ADMIN_COOKIE)?.value);
  return a?.admin ? a : null;
}
